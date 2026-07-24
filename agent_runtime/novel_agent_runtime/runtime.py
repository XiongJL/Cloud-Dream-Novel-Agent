from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import ValidationError

from .execution_graph import ExecutionState, PlanExecutionGraph
from .exploration_graph import AgentExplorationGraph, ExplorationState
from .events import AgentEventBus
from .invocations import SideEffectResultUnknown, ToolInvocationRecord, build_invocation_key
from .planner import (
    build_plan_from_model,
    infer_deliverable_effect,
    revise_plan_from_model,
    route_plan_from_intent,
    validate_plan_effect,
)
from .request_graph import RetryableRequestGraph
from .retry import AgentRequestError
from .intent.operations import INTENT_OPERATION_REGISTRY
from .intent.rules import detect_explicit_operations
from .intent.schemas import (
    FailedRunRef,
    IntentConversationState,
    IntentDecision,
    IntentEntryHint,
    IntentRequest,
    IntentSelectionContext,
    PendingClarificationRef,
    PriorIntentRef,
)
from .intent.service import IntentService
from .roles import list_agent_roles
from .schemas import (
    AgentArtifact,
    AgentChatResponse,
    AgentMessage,
    AgentPlan,
    AgentPlanStep,
    AgentRun,
    AgentRunEvent,
    AgentRunStatusResult,
    AgentState,
    ExpertFinding,
    ExpertReportPayload,
    new_id,
    utc_now,
)
from .store import AgentStateStore
from .tool_adapter import AgentToolAdapter, AutomationInvoker, HttpAgentToolAdapter
from .tool_manifest import AGENT_TOOL_BY_NAME, AVAILABLE_AGENT_TOOLS, DRAFT_TOOLS, READ_ONLY_AGENT_TOOLS
from .toolchains.registry import TOOLCHAIN_REGISTRY
from .toolchains.chapter_consistency_review import normalize_review, review_markdown, review_request
from .toolchains.chapter_continuation import (
    build_continuation_context_bundle,
    build_generation_brief,
    chapter_draft_params,
    continuation_context_params,
    normalize_chapter_draft,
)
from .toolchains.chapter_sequence_continuation import (
    advance_batch_state_ledger,
    batch_create_params,
    batch_regeneration_params,
    beat_generation_params,
    chapter_beats_checkpoint,
    normalize_beat_inputs,
    normalize_draft_batch,
    normalize_generated_child,
    normalize_regeneration_preparation,
    sequence_child_params,
    sequence_context_params,
)
from .toolchains.chapter_batch_rewrite import (
    assert_rewrite_batch_alignment,
    normalize_rewrite_scope_bundle,
    rewrite_batch_create_params,
    rewrite_child_params,
    rewrite_scope_context_params,
)
from .toolchains.chapter_context import (
    CONTEXT_NODES,
    apply_node_failure,
    apply_node_result,
    apply_node_skip,
    build_context_bundle,
    build_tool_call,
    exhaust_context_budget,
    initial_context_state,
)
from .toolchains.chapter_scope_context import (
    SCOPE_CONTEXT_NODES,
    apply_scope_node_failure,
    apply_scope_node_result,
    build_scope_bundle,
    build_scope_tool_call,
    initial_scope_context_state,
)
from .toolchains.creative_asset_draft import (
    CREATIVE_CONTEXT_NODES,
    apply_creative_failure,
    apply_creative_result,
    build_creative_brief,
    build_creative_context,
    build_creative_tool_call,
    creative_generation_params,
    exhaust_creative_budget,
    initial_creative_asset_state,
    normalize_creative_draft,
    normalize_creative_validation,
)
from .toolchains.editor_range_review import (
    editor_range_review_markdown,
    editor_range_review_request,
    normalize_editor_range_review,
)
from .toolchains.writer_range_revision_plan import (
    normalize_writer_range_revision_plan,
    writer_range_revision_plan_markdown,
    writer_range_revision_plan_request,
)
from .toolchains.reader_journey_review import (
    build_reader_journey_artifact,
    normalize_reader_chapter_evaluation,
    reader_chapter_request,
    reader_journey_markdown,
)
from .toolchains.worldbuilding_range_consistency import (
    normalize_worldbuilding_consistency,
    worldbuilding_consistency_markdown,
    worldbuilding_consistency_request,
)
from .toolchains.research_range_fact_check import (
    normalize_research_claims,
    normalize_research_fact_check,
    research_claim_extraction_request,
    research_fact_check_markdown,
    research_fact_check_request,
    research_search_evidence,
    research_search_params,
)
from .toolchains.scope_audit import (
    normalize_scope_audit,
    scope_audit_markdown,
    scope_audit_request,
)
from .toolchains.plotline_analysis import (
    PLOTLINE_SCOPE_OPTIONS,
    apply_chapter_batch_failure,
    apply_chapter_batch_result,
    apply_plotline_result,
    apply_rag_failure,
    apply_rag_result,
    apply_volume_result,
    build_chapter_batch_call,
    build_plotline_batches,
    build_plotline_context,
    infer_plotline_scope,
    initial_plotline_analysis_state,
    normalize_plotline_analysis,
    plotline_analysis_markdown,
    plotline_analysis_request,
    plotline_rag_params,
    resolve_plotline_scope,
    skip_remaining_batches,
)
from .toolchains.schemas import (
    ChapterContextInput,
    ChapterBatchRewriteInput,
    ChapterContinuationInput,
    ChapterDraftBatchResult,
    ChapterSequenceContinuationInput,
    ChapterScopeContextInput,
    ContextEvidence,
    CreativeAssetDraftInput,
    DraftToolchainResult,
    EditorRangeReviewInput,
    PlotlineAnalysisInput,
    ReaderChapterEvaluation,
    ReaderJourneyReviewInput,
    ResearchExtractedClaim,
    ResearchRangeFactCheckInput,
    ScopeAuditExpertRef,
    ScopeAuditInput,
    WorldbuildingRangeConsistencyInput,
    WriterRangeRevisionPlanInput,
    ToolchainInvocation,
    ToolchainError,
)


class NovelAgentRuntime:
    _CHAPTER_SCOPE_TOOLCHAINS = {
        "chapter.scope_context",
        "chapter.batch_rewrite",
        "writer.range_revision_plan",
        "editor.range_review",
        "reader.journey_review",
        "worldbuilding.range_consistency",
        "research.range_fact_check",
        "novel.scope_audit",
    }

    def __init__(
        self,
        store: AgentStateStore,
        automation: AutomationInvoker,
        event_bus: AgentEventBus,
        tool_adapter: AgentToolAdapter | None = None,
    ) -> None:
        self.store = store
        self.automation = automation
        self.tool_adapter = tool_adapter or HttpAgentToolAdapter(automation)
        self.tool_transport = self.tool_adapter.transport_name
        self.event_bus = event_bus
        self.intent_service = IntentService()
        self.state: AgentState = store.load()
        self._run_tasks: dict[str, asyncio.Task[None]] = {}
        self._active_request_ids: dict[str, set[str]] = {}
        self._active_tool_request_ids: dict[str, set[str]] = {}
        self.exploration_graph = AgentExplorationGraph(store.state_dir / "agent_graph.db", READ_ONLY_AGENT_TOOLS)
        self.execution_graph = PlanExecutionGraph(store.state_dir / "agent_graph.db")
        self.request_graph = RetryableRequestGraph()
        self.store.recover_in_flight_invocations()
        self._mark_interrupted_runs()

    def _save(self) -> None:
        self.store.save(self.state)

    def _mark_interrupted_runs(self) -> None:
        changed = False
        for run in self.state.runs.values():
            if run.status not in {"running", "cancelling", "waiting_approval"}:
                continue
            unknown_invocations = self.store.list_invocations(run.runId, statuses={"unknown"})
            if (
                not unknown_invocations
                and run.status == "waiting_approval"
                and run.pendingApproval
                and self.execution_graph.has_checkpoint(f"run:{run.runId}")
            ):
                continue
            run.status = "failed"
            run.pendingApproval = None
            changed = True
            event = AgentRunEvent(
                eventId=new_id("evt"),
                runId=run.runId,
                planId=run.planId,
                threadId=run.threadId,
                stepId=run.currentStepId,
                type="run_failed",
                status="failed",
                payload={
                    "message": (
                        "Agent runtime restarted while a draft write result was unknown. The write was not replayed; "
                        "review the draft center and reconfirm before starting a new run."
                        if unknown_invocations
                        else "Agent runtime restarted before this run completed. Please create a new run."
                    ),
                    "reason": "side_effect_result_unknown" if unknown_invocations else "runtime_interrupted",
                    "code": "SIDE_EFFECT_UNKNOWN" if unknown_invocations else "RUNTIME_INTERRUPTED",
                    "unknownInvocations": [
                        {
                            "invocationKey": item.invocationKey,
                            "requestId": item.requestId,
                            "method": item.method,
                            "stepId": item.stepId,
                        }
                        for item in unknown_invocations
                    ],
                },
            )
            persisted = self.store.append_event(event)
            run.events.append(persisted)
            if len(run.events) > 50:
                run.events = run.events[-50:]
        if changed:
            self._save()

    def roles(self, params: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        return [role.model_dump() for role in list_agent_roles(locale)]

    def _explicit_chapter_scope(
        self,
        params: dict[str, Any],
        context: dict[str, Any],
        *,
        goal: str,
    ) -> dict[str, Any] | None:
        payload = params.get("chapterScope") or context.get("chapterScope")
        if not isinstance(payload, dict):
            return None
        raw_scope = {
            **payload,
            "novelId": str(params.get("novelId") or context.get("novelId") or payload.get("novelId") or ""),
            "chapterId": str(params.get("chapterId") or context.get("chapterId") or payload.get("chapterId") or "") or None,
            "volumeId": str(payload.get("volumeId") or params.get("volumeId") or context.get("volumeId") or "") or None,
            "goal": goal,
            "locale": str(params.get("locale") or context.get("locale") or "zh-CN"),
        }
        normalized = ChapterScopeContextInput.model_validate(raw_scope)
        explicit = normalized.model_dump(
            include={"scopeId", "kind", "volumeId", "chapterId", "chapterIds", "anchorChapterId", "processingMode"},
            exclude_none=True,
        )
        experts = payload.get("experts")
        if isinstance(experts, list):
            allowed_experts = {"editor", "reader", "worldbuilding", "research_rag"}
            normalized_experts = list(dict.fromkeys(str(item) for item in experts if str(item) in allowed_experts))
            if normalized_experts:
                explicit["experts"] = normalized_experts
        return explicit

    def _apply_explicit_chapter_scope(
        self,
        plan: AgentPlan,
        params: dict[str, Any],
        context: dict[str, Any],
    ) -> AgentPlan:
        explicit = self._explicit_chapter_scope(params, context, goal=plan.goal)
        if not explicit:
            return plan
        next_steps: list[AgentPlanStep] = []
        for step in plan.steps:
            invocation = step.toolchain
            if invocation is None or invocation.id not in self._CHAPTER_SCOPE_TOOLCHAINS:
                next_steps.append(step)
                continue
            scope_input = {key: value for key, value in explicit.items() if key != "experts"}
            if invocation.id == "novel.scope_audit" and explicit.get("experts"):
                scope_input["experts"] = explicit["experts"]
            next_invocation = invocation.model_copy(update={"input": {**invocation.input, **scope_input}})
            next_steps.append(step.model_copy(update={"toolchain": next_invocation}))
        return plan.model_copy(update={"steps": next_steps})

    async def chat(self, params: dict[str, Any], context: dict[str, Any]) -> AgentChatResponse:
        message = str(params.get("message") or "").strip()
        conversation_id = str(params.get("conversationId") or new_id("conv"))
        role = str(params.get("role") or "team")
        approval_mode = str(params.get("approvalMode") or params.get("workMode") or "review_required")
        if not message:
            raise ValueError("message is required")
        history = self.state.conversations.setdefault(conversation_id, [])
        incoming_history = params.get("history")
        if isinstance(incoming_history, list):
            synchronized_history: list[AgentMessage] = []
            for item in incoming_history:
                if not isinstance(item, dict):
                    continue
                item_role = str(item.get("role") or "")
                item_content = str(item.get("content") or "").strip()
                if item_role not in {"user", "assistant"} or not item_content:
                    continue
                message_payload: dict[str, Any] = {"role": item_role, "content": item_content}
                if item.get("messageId") or item.get("id"):
                    message_payload["messageId"] = str(item.get("messageId") or item.get("id"))
                if item.get("createdAt"):
                    message_payload["createdAt"] = str(item["createdAt"])
                synchronized_history.append(AgentMessage.model_validate(message_payload))
            history = synchronized_history
            self.state.conversations[conversation_id] = history
        conversation_context = params.get("conversationContext")
        if not isinstance(conversation_context, dict):
            conversation_context = {}
        persistent_summary = params.get("persistentSummary")
        if not isinstance(persistent_summary, dict) or persistent_summary.get("version") != "agent-conversation-summary-v1":
            persistent_summary = None
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        exploration_context = {
            "novelId": str(params.get("novelId") or context.get("novelId") or ""),
            "volumeId": str(params.get("volumeId") or context.get("volumeId") or ""),
            "chapterId": str(params.get("chapterId") or context.get("chapterId") or ""),
        }
        selection_context = {
            **exploration_context,
            "novelTitle": str(params.get("novelTitle") or context.get("novelTitle") or ""),
            "chapterTitle": str(params.get("chapterTitle") or context.get("chapterTitle") or ""),
            "currentContent": str(params.get("currentContentText") or ""),
        }
        explicit_scope = self._explicit_chapter_scope(params, context, goal=message)
        if explicit_scope:
            selection_context["chapterScope"] = explicit_scope
        active_plan = conversation_context.get("currentPlan")
        active_run = conversation_context.get("activeRun")
        active_run_id = (
            str(active_run.get("runId"))
            if isinstance(active_run, dict) and active_run.get("runId")
            else None
        )
        latest_failed_run = self._retryable_failed_run_ref(active_run_id)
        pending_payload = self.state.pendingClarifications.get(conversation_id)
        pending_clarification = PendingClarificationRef.model_validate(pending_payload) if pending_payload else None
        previous_intent: PriorIntentRef | None = None
        previous_intent_payload = self.state.intentDecisions.get(conversation_id)
        if previous_intent_payload:
            try:
                previous_decision = IntentDecision.model_validate(previous_intent_payload)
                previous_intent = PriorIntentRef(
                    operationIds=[operation.type for operation in previous_decision.operations],
                    deliverable=previous_decision.deliverable,
                    suggestedRole=previous_decision.suggestedRole,
                )
            except ValidationError:
                previous_intent = None
        entry_hint_payload = params.get("entryHint")
        entry_hint = IntentEntryHint.model_validate(entry_hint_payload) if isinstance(entry_hint_payload, dict) else None
        intent_request = IntentRequest(
            message=message,
            conversationId=conversation_id,
            locale=locale,
            role=role,
            approvalMode=approval_mode,
            source=params.get("source") if params.get("source") in {"chat", "shortcut", "preset"} else "chat",
            entryHint=entry_hint,
            currentSelection=IntentSelectionContext(
                novelId=exploration_context["novelId"] or None,
                volumeId=exploration_context["volumeId"] or None,
                chapterId=exploration_context["chapterId"] or None,
                selectedText=str(params.get("selectedText") or "").strip() or None,
            ),
            conversationState=IntentConversationState(
                activePlanId=str(active_plan.get("planId")) if isinstance(active_plan, dict) and active_plan.get("planId") else None,
                activeRunId=active_run_id,
                pendingClarification=pending_clarification,
                hasPendingApproval=isinstance(active_run, dict) and bool(active_run.get("pendingApproval")),
                previousIntent=previous_intent,
                latestFailedRun=latest_failed_run,
            ),
        )
        preflight = self.intent_service.preflight(intent_request)
        normalized_message = message.strip().lower()
        explicitly_broader_chapter_scope = any(marker in normalized_message for marker in (
            "多章", "几章", "跨章", "跨章节", "相邻章节", "上一章", "下一章",
            "当前卷", "全卷", "整卷", "全书", "整本", "所有章节", "多个章节",
            "multiple chapters", "adjacent chapters", "current volume", "whole novel", "entire novel",
        ))
        selected_chapter_operation = (
            bool(exploration_context["chapterId"])
            and not explicitly_broader_chapter_scope
            and any(
            (definition := INTENT_OPERATION_REGISTRY.get(operation_id)) is not None
            and definition.targetKind == "chapter"
            for operation_id in detect_explicit_operations(message)
            )
        )

        async def model_call(graph_state: ExplorationState) -> dict[str, Any]:
            result = await self.automation.invoke(
                "agent.generate_chat",
                {
                    "message": message,
                    "role": role,
                    "approvalMode": approval_mode,
                    "locale": locale,
                    "history": [item.model_dump() for item in history],
                    "availableReadTools": READ_ONLY_AGENT_TOOLS if approval_mode != "chat_only" else [],
                    "availableOperations": INTENT_OPERATION_REGISTRY.list_public(),
                    "intentPreflight": preflight.model_dump(),
                    "selectionContext": selection_context,
                    "toolObservations": graph_state["observations"],
                    "conversationContext": conversation_context,
                    "persistentSummary": persistent_summary,
                },
                "desktop-ui",
            )
            if not isinstance(result, dict):
                return {}
            raw_calls = result.get("toolCalls")
            if selected_chapter_operation and isinstance(raw_calls, list):
                has_chapter_read = any(
                    isinstance(item, dict) and item.get("name") == "chapter.get"
                    for item in raw_calls
                )
                already_read_selected_chapter = any(
                    observation.get("toolName") == "chapter.get" and observation.get("ok") is True
                    for observation in graph_state["observations"]
                )
                redirected = False
                next_calls: list[dict[str, Any]] = []
                for item in raw_calls:
                    if not isinstance(item, dict):
                        continue
                    if item.get("name") in {"novel.list", "volume.list", "chapter.list"}:
                        if not has_chapter_read and not already_read_selected_chapter and not redirected:
                            next_calls.append({"name": "chapter.get", "args": {"chapterId": exploration_context["chapterId"]}})
                            redirected = True
                        continue
                    next_calls.append(item)
                result = {**result, "toolCalls": next_calls}
            return result

        async def tool_call(tool_name: str, tool_args: dict[str, Any]) -> Any:
            return await self._invoke_exploration_tool(
                tool_name,
                tool_args,
                message,
                exploration_context,
                locale,
            )

        if self.intent_service.retry_failed_run_action(intent_request) is not None:
            graph_result = {
                "decision": {"content": "resume", "shouldPlan": False, "needsClarification": False},
                "tool_trace": [],
            }
        else:
            graph_result = await self.exploration_graph.run(
                conversation_id,
                ExplorationState(
                    message=message,
                    role=role,
                    approval_mode=approval_mode,
                    locale=locale,
                    history=[item.model_dump() for item in history],
                    context=exploration_context,
                    observations=[],
                    tool_trace=[],
                    pending_tool_calls=[],
                    decision={},
                    iterations=0,
                ),
                model_call,
                tool_call,
            )
        result = graph_result["decision"]
        if not isinstance(result, dict) or not str(result.get("content") or "").strip():
            raise ValueError("Agent chat returned an invalid response")
        semantic = self.intent_service.normalize_semantic(result)
        intent_decision = self.intent_service.finalize(
            intent_request,
            preflight,
            semantic,
            exploration_performed=bool(graph_result["tool_trace"]),
        )
        awaiting_user_input = intent_decision.route == "clarify"
        wants_plan = intent_decision.route == "plan"
        wants_retry = intent_decision.route == "retry_failed_run"
        content = intent_decision.responseContent
        context_compression = result.get("contextCompression")
        if not isinstance(context_compression, dict) or context_compression.get("applied") is not True:
            context_compression = None
        context_diagnostics = result.get("contextDiagnostics")
        if not isinstance(context_diagnostics, dict) or context_diagnostics.get("contextVersion") != "agent-context-v1":
            context_diagnostics = None
        conversation_summary = result.get("conversationSummary")
        if not isinstance(conversation_summary, dict) or conversation_summary.get("version") != "agent-conversation-summary-v1":
            conversation_summary = None
        history.append(AgentMessage(
            messageId=str(params.get("messageId") or new_id("message")),
            role="user",
            content=message,
        ))
        assistant = AgentMessage(role="assistant", content=content)
        history.append(assistant)
        if awaiting_user_input:
            self.state.pendingClarifications[conversation_id] = PendingClarificationRef(
                questionId=new_id("question"),
                question=content,
            ).model_dump()
        elif preflight.pendingClarification:
            self.state.pendingClarifications.pop(conversation_id, None)
        self.state.intentDecisions[conversation_id] = intent_decision.model_dump()
        self._save()

        return AgentChatResponse(
            conversationId=conversation_id,
            assistantMessage=assistant,
            suggestedActions=(
                [{"label": "生成计划草稿", "method": "agent.plan"}]
                if wants_plan
                else [{"label": "重试失败步骤", "method": "agent.retry_run"}]
                if wants_retry
                else []
            ),
            awaitingUserInput=awaiting_user_input,
            contextReads=graph_result["tool_trace"],
            contextDiagnostics=context_diagnostics,
            contextCompression=context_compression,
            conversationSummary=conversation_summary,
            intentDecision=intent_decision,
        )

    def _retryable_failed_run_ref(self, run_id: str | None) -> FailedRunRef | None:
        if not run_id:
            return None
        failed_run = self.state.runs.get(run_id)
        if failed_run is None or failed_run.status != "failed" or failed_run.failureRevision < 1:
            return None
        if any(run.retryOfRunId == failed_run.runId for run in self.state.runs.values()):
            return None
        events = self.store.list_events(failed_run.runId)
        terminal = next((event for event in reversed(events) if event.type == "run_failed"), None)
        terminal_code = str((terminal.payload if terminal else {}).get("code") or "")
        if terminal_code == "SIDE_EFFECT_UNKNOWN" or any(
            event.payload.get("code") == "SIDE_EFFECT_UNKNOWN" for event in events
        ):
            return None
        exhausted = next((event for event in reversed(events) if event.type == "request_retry_exhausted"), None)
        if exhausted is None or exhausted.payload.get("retryable") is not True:
            return None
        return FailedRunRef(
            runId=failed_run.runId,
            failureRevision=failed_run.failureRevision,
            retryable=True,
            code=str(exhausted.payload.get("code") or terminal_code) or None,
        )

    async def _invoke_exploration_tool(
        self,
        tool_name: str,
        tool_args: dict[str, Any],
        message: str,
        context: dict[str, str],
        locale: str,
    ) -> Any:
        if tool_name not in READ_ONLY_AGENT_TOOLS:
            raise ValueError(f"Exploration tool is not read-only: {tool_name}")
        novel_id = context.get("novelId") or ""
        volume_id = context.get("volumeId") or ""
        chapter_id = context.get("chapterId") or ""
        if tool_name == "novel.list":
            params: dict[str, Any] = {}
        elif tool_name == "volume.list":
            if not novel_id:
                raise ValueError("novelId is required for volume.list")
            params = {"novelId": novel_id}
        elif tool_name == "chapter.list":
            requested_volume_id = str(tool_args.get("volumeId") or volume_id).strip()
            if not requested_volume_id or requested_volume_id.upper() in {"ALL", "ALL_IF_SUPPORTED"}:
                raise ValueError("volumeId is required for chapter.list")
            params = {"volumeId": requested_volume_id}
        elif tool_name == "chapter.get":
            requested_chapter_id = str(tool_args.get("chapterId") or chapter_id).strip()
            if not requested_chapter_id or requested_chapter_id.upper() in {"ALL", "ALL_IF_SUPPORTED"}:
                raise ValueError("chapterId is required for chapter.get")
            params = {"chapterId": requested_chapter_id}
        elif tool_name == "rag.ask":
            if not novel_id:
                raise ValueError("novelId is required for rag.ask")
            params = {
                "novelId": novel_id,
                "question": str(tool_args.get("question") or message),
                "locale": locale,
                "scope": "novel",
                "maxEvidence": 8,
            }
        elif tool_name == "search.query":
            if not novel_id:
                raise ValueError("novelId is required for search.query")
            params = {"novelId": novel_id, "keyword": str(tool_args.get("keyword") or message)}
        else:
            if not novel_id:
                raise ValueError(f"novelId is required for {tool_name}")
            params = {"novelId": novel_id}
        return await self.tool_adapter.invoke(tool_name, params, "desktop-ui")

    async def plan(self, params: dict[str, Any], context: dict[str, Any]) -> AgentPlan:
        goal = str(params.get("goal") or params.get("message") or "")
        if not goal.strip():
            raise ValueError("goal is required")
        intent_payload = params.get("intentDecision")
        intent_decision = IntentDecision.model_validate(intent_payload) if isinstance(intent_payload, dict) else None
        result = await self._retryable_automation_invoke(
            None,
            "agent.generate_plan",
            {
                "goal": goal,
                "role": str(params.get("role") or "team"),
                "locale": str(params.get("locale") or context.get("locale") or "zh-CN"),
                "availableTools": AVAILABLE_AGENT_TOOLS,
                "availableToolchains": TOOLCHAIN_REGISTRY.list_public(),
                "intentDecision": intent_decision.model_dump() if intent_decision else None,
            },
        )
        plan = build_plan_from_model(goal, result, str(params.get("role") or "team"))
        plan = route_plan_from_intent(
            plan,
            intent_decision,
            has_chapter=bool(params.get("chapterId") or context.get("chapterId")),
        )
        plan = self._apply_explicit_chapter_scope(plan, params, context)
        self.state.plans[plan.planId] = plan
        self._save()
        return plan

    def register_plan(self, params: dict[str, Any], context: dict[str, Any]) -> AgentPlan:
        raw_plan = params.get("plan")
        if not isinstance(raw_plan, dict):
            raise ValueError("plan is required")
        plan = AgentPlan.model_validate(raw_plan)
        if plan.requestedEffect == "unknown":
            plan = plan.model_copy(update={"requestedEffect": infer_deliverable_effect(plan.deliverable)})
        validate_plan_effect(plan)
        if not plan.requiresApproval:
            raise ValueError("Registered plans must require user approval")
        if not plan.steps:
            raise ValueError("Registered plans must contain at least one step")
        step_ids = [step.stepId for step in plan.steps]
        if len(step_ids) != len(set(step_ids)):
            raise ValueError("Registered plan contains duplicate stepId values")

        plan = plan.model_copy(update={
            "steps": [step.model_copy(update={"status": "pending"}) for step in plan.steps],
        })
        plan = self._apply_explicit_chapter_scope(plan, params, context)
        for step in plan.steps:
            unknown_tools = sorted(set(step.tools) - set(AVAILABLE_AGENT_TOOLS))
            if unknown_tools:
                raise ValueError(f"Registered plan contains unknown tools: {', '.join(unknown_tools)}")
            if step.toolchain:
                if step.tools:
                    raise ValueError("A registered plan step cannot mix atomic tools and a Toolchain")
                role = "team" if step.agent == "supervisor" else step.agent
                definition = TOOLCHAIN_REGISTRY.resolve(step.toolchain.id, step.toolchain.version, role)
                definition.inputModel.model_validate(step.toolchain.input)

        existing = self.state.plans.get(plan.planId)
        if existing:
            if existing.model_dump() != plan.model_dump():
                raise ValueError("planId already exists with different content")
            return existing
        self.state.plans[plan.planId] = plan
        self._save()
        return plan

    async def revise_plan(self, params: dict[str, Any], context: dict[str, Any]) -> AgentPlan:
        plan_id = str(params.get("planId") or "")
        revision = str(params.get("revision") or "").strip()
        plan = self.state.plans.get(plan_id)
        if not plan:
            raise ValueError("planId not found")
        if not revision:
            raise ValueError("revision is required")
        if any(run.planId == plan_id and run.status in {"running", "cancelling", "waiting_approval"} for run in self.state.runs.values()):
            raise ValueError("Cannot revise a plan while it is running")
        result = await self._retryable_automation_invoke(
            None,
            "agent.revise_plan",
            {
                "goal": plan.goal,
                "revision": revision,
                "role": str(params.get("role") or "team"),
                "locale": str(params.get("locale") or context.get("locale") or "zh-CN"),
                "availableTools": AVAILABLE_AGENT_TOOLS,
                "availableToolchains": TOOLCHAIN_REGISTRY.list_public(),
                "currentPlan": plan.model_dump(),
            },
        )
        revised = revise_plan_from_model(plan, result)
        revised = self._apply_explicit_chapter_scope(revised, params, context)
        self.state.plans[plan_id] = revised
        self._save()
        return revised

    async def execute_plan(self, params: dict[str, Any], context: dict[str, Any]) -> AgentRun:
        plan_id = str(params.get("planId") or "")
        plan = self.state.plans.get(plan_id)
        if not plan:
            raise ValueError("planId not found")
        validate_plan_effect(plan)

        approval = params.get("approval")
        if not isinstance(approval, dict) or approval.get("approved") is not True:
            raise ValueError("Explicit plan approval is required")
        requested_step_ids = approval.get("approvedStepIds")
        if not isinstance(requested_step_ids, list) or not requested_step_ids:
            raise ValueError("approvedStepIds must contain at least one step")
        approved_step_ids = {str(step_id) for step_id in requested_step_ids}
        known_step_ids = {step.stepId for step in plan.steps}
        unknown_step_ids = approved_step_ids - known_step_ids
        if unknown_step_ids:
            raise ValueError(f"Unknown approvedStepIds: {', '.join(sorted(unknown_step_ids))}")
        required_tool = DRAFT_TOOLS.get(plan.deliverable)
        approved_tools: set[str] = set()
        for step in plan.steps:
            if step.stepId not in approved_step_ids:
                continue
            approved_tools.update(step.tools)
            if step.toolchain:
                role = "team" if step.agent == "supervisor" else step.agent
                definition = TOOLCHAIN_REGISTRY.resolve(step.toolchain.id, step.toolchain.version, role)
                approved_tools.update(definition.requiredTools)
        if required_tool and required_tool not in approved_tools:
            raise ValueError(
                f"Approved steps do not produce the declared deliverable: {plan.deliverable} requires {required_tool}"
            )

        run = AgentRun(runId=new_id("run"), threadId=plan.threadId, planId=plan.planId, status="running")
        self.state.runs[run.runId] = run
        for step in plan.steps:
            step.status = "pending" if step.stepId in approved_step_ids else "skipped"

        novel_id = str(params.get("novelId") or context.get("novelId") or "")
        volume_id = params.get("volumeId") or context.get("volumeId")
        chapter_id = params.get("chapterId") or context.get("chapterId")
        current_content = str(params.get("currentContent") or "")
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        await self._emit(run, "run_started", payload={"planId": plan.planId, "title": plan.title})
        await self._emit(run, "plan_approved", payload={"approvedStepIds": sorted(approved_step_ids)})
        execution_state = ExecutionState(
            run_id=run.runId,
            approved_step_ids=sorted(approved_step_ids),
            novel_id=novel_id,
            volume_id=str(volume_id) if volume_id else None,
            chapter_id=str(chapter_id) if chapter_id else None,
            current_content=current_content,
            locale=locale,
            step_index=0,
            tool_index=0,
            phase="start_step",
            action="continue",
            checkpoint=None,
            resume_response=None,
            latest_analysis_summary="",
            report_findings=[],
            creative_direction_checked=False,
            toolchain_state=None,
        )
        task = asyncio.create_task(self._run_graph_guarded(run.runId, initial_state=execution_state))
        self._run_tasks[run.runId] = task
        self._save()
        return run

    async def retry_run(self, params: dict[str, Any], context: dict[str, Any]) -> AgentRun:
        del context
        failed_run_id = str(params.get("failedRunId") or "").strip()
        if not failed_run_id:
            raise ValueError("failedRunId is required")
        failed_run = self.state.runs.get(failed_run_id)
        if not failed_run:
            raise ValueError("failedRunId not found")
        if failed_run.status != "failed":
            raise ValueError("Only a failed run can be retried")
        expected_revision = params.get("expectedFailureRevision")
        if not isinstance(expected_revision, int) or expected_revision < 1:
            raise ValueError("expectedFailureRevision must be a positive integer")
        if failed_run.failureRevision != expected_revision:
            raise ValueError("Failed run revision conflict")
        mode = str(params.get("mode") or "failed_node")
        if mode != "failed_node":
            raise ValueError("Only failed_node retry mode is implemented")
        linked_retry = next(
            (run for run in self.state.runs.values() if run.retryOfRunId == failed_run.runId),
            None,
        )
        if linked_retry is not None:
            raise ValueError(f"Failed run already has a linked retry: {linked_retry.runId}")

        events = self.store.list_events(failed_run.runId)
        exhausted = next((event for event in reversed(events) if event.type == "request_retry_exhausted"), None)
        terminal = next((event for event in reversed(events) if event.type == "run_failed"), None)
        terminal_code = str((terminal.payload if terminal else {}).get("code") or "")
        if terminal_code == "SIDE_EFFECT_UNKNOWN" or any(
            event.payload.get("code") == "SIDE_EFFECT_UNKNOWN" for event in events
        ):
            raise ValueError("SIDE_EFFECT_UNKNOWN must be reconciled before retry")
        if exhausted is None or exhausted.payload.get("retryable") is not True:
            raise ValueError("The failed run has no retryable exhausted request")

        checkpoint_state = self.execution_graph.load_checkpoint_state(f"run:{failed_run.runId}")
        if checkpoint_state is None:
            raise ValueError("Failed run checkpoint is unavailable")
        plan = self.state.plans.get(failed_run.planId)
        if plan is None:
            raise ValueError("Failed run plan is unavailable")

        retry_attempt = failed_run.retryAttempt + 1
        retry_root_run_id = failed_run.retryRootRunId or failed_run.retryOfRunId or failed_run.runId
        resumed_from = {
            "phase": checkpoint_state.get("phase"),
            "stepIndex": checkpoint_state.get("step_index"),
            "toolIndex": checkpoint_state.get("tool_index"),
            "stepId": failed_run.currentStepId,
            "nodeId": exhausted.payload.get("nodeId"),
            "method": exhausted.payload.get("method"),
            "diagnosticRef": exhausted.payload.get("diagnosticRef"),
        }
        retry_run = AgentRun(
            runId=new_id("run"),
            threadId=failed_run.threadId,
            planId=failed_run.planId,
            status="running",
            currentStepId=failed_run.currentStepId,
            progress=failed_run.progress,
            artifacts=[artifact.model_copy(deep=True) for artifact in failed_run.artifacts],
            draftSessionId=failed_run.draftSessionId,
            draftBatchId=failed_run.draftBatchId,
            approvalResponses=[dict(response) for response in failed_run.approvalResponses],
            retryOfRunId=failed_run.runId,
            retryRootRunId=retry_root_run_id,
            retryAttempt=retry_attempt,
            resumedFrom=resumed_from,
        )
        self.state.runs[retry_run.runId] = retry_run

        if checkpoint_state.get("phase") != "final_report" and retry_run.currentStepId:
            failed_step = next((step for step in plan.steps if step.stepId == retry_run.currentStepId), None)
            if failed_step:
                failed_step.status = "running"
        resumed_state = ExecutionState(**{
            **checkpoint_state,
            "run_id": retry_run.runId,
            "action": "continue",
            "checkpoint": None,
            "resume_response": None,
        })
        await self._emit(
            retry_run,
            "run_started",
            payload={
                "planId": plan.planId,
                "title": plan.title,
                "retryOfRunId": failed_run.runId,
                "retryAttempt": retry_attempt,
            },
        )
        await self._emit(
            retry_run,
            "run_retry_started",
            step_id=retry_run.currentStepId,
            status="running",
            payload={
                "retryOfRunId": failed_run.runId,
                "retryRootRunId": retry_root_run_id,
                "retryAttempt": retry_attempt,
                "failureRevision": failed_run.failureRevision,
                "mode": mode,
                "resumedFrom": resumed_from,
            },
        )
        task = asyncio.create_task(self._run_graph_guarded(retry_run.runId, initial_state=resumed_state))
        self._run_tasks[retry_run.runId] = task
        self._save()
        return retry_run

    async def revise_draft(self, params: dict[str, Any], context: dict[str, Any]) -> AgentRun:
        source_draft_session_id = str(params.get("sourceDraftSessionId") or "").strip()
        if not source_draft_session_id:
            raise ValueError("sourceDraftSessionId is required")
        source_draft_version = params.get("sourceDraftVersion")
        if not isinstance(source_draft_version, int) or source_draft_version < 1:
            raise ValueError("sourceDraftVersion must be a positive integer")
        comments = params.get("comments")
        if not isinstance(comments, list) or not comments:
            raise ValueError("comments is required")
        normalized_comments: list[dict[str, Any]] = []
        for item in comments:
            if not isinstance(item, dict) or not str(item.get("body") or "").strip():
                raise ValueError("Each review comment must contain body")
            normalized_comments.append(dict(item))
        if any(
            run.draftSessionId == source_draft_session_id
            and run.status in {"running", "waiting_approval", "cancelling"}
            for run in self.state.runs.values()
        ):
            raise ValueError("Draft already has an active revision run")

        source = await self.tool_adapter.invoke(
            "draft.get",
            {"draftSessionId": source_draft_session_id},
            str(context.get("origin") or "desktop-ui"),
        )
        source_type = str(source.get("type") or "") if isinstance(source, dict) else ""
        if source_type not in {"chapter-draft", "creative-assets"}:
            raise ValueError("Source reviewable draft was not found")
        if source_type == "chapter-draft" and source.get("draftBatchId"):
            raise ValueError("Batch child drafts must use agent.regenerate_batch")
        if source.get("status") != "draft":
            raise ValueError("Only the current reviewable draft can be regenerated")
        if int(source.get("version") or 0) != source_draft_version:
            raise ValueError("Source draft version conflict")

        review_request_id = str(params.get("reviewRequestId") or "").strip() or new_id("review")
        thread_id = str(params.get("threadId") or "").strip() or new_id("thread")
        is_creative_assets = source_type == "creative-assets"
        revision_tool = "creative_assets.revise_draft" if is_creative_assets else "chapter.revise_draft"
        revision_title = "重新生成创作素材审核包" if is_creative_assets else "重新生成待审核版本"
        step = AgentPlanStep(
            stepId=new_id("step"),
            agent="writer",
            title="根据审批意见重新生成创作素材" if is_creative_assets else "根据审批意见重新生成草稿",
            tools=[revision_tool],
            status="pending",
        )
        plan = AgentPlan(
            planId=new_id("plan"),
            threadId=thread_id,
            title=revision_title,
            goal=f"根据 {len(normalized_comments)} 条审批意见生成新的待审核版本",
            requiresApproval=True,
            steps=[step],
            preferredRole="writer",
            deliverable="creative_assets_draft" if is_creative_assets else "chapter_draft",
        )
        self.state.plans[plan.planId] = plan
        run = AgentRun(
            runId=new_id("run"),
            threadId=thread_id,
            planId=plan.planId,
            status="running",
        )
        self.state.runs[run.runId] = run
        await self._emit(
            run,
            "run_started",
            payload={
                "planId": plan.planId,
                "title": plan.title,
                "kind": "creative_assets_review_revision" if is_creative_assets else "review_revision",
                "sourceDraftSessionId": source_draft_session_id,
                "reviewRequestId": review_request_id,
                "commentCount": len(normalized_comments),
            },
        )
        await self._emit(
            run,
            "plan_approved",
            payload={"approvedStepIds": [step.stepId], "source": "review_comments_confirmation"},
        )
        task = asyncio.create_task(self._revise_draft_guarded(
            run.runId,
            {
                "sourceDraftSessionId": source_draft_session_id,
                "sourceDraftVersion": source_draft_version,
                "reviewRequestId": review_request_id,
                "comments": normalized_comments,
                "locale": str(params.get("locale") or context.get("locale") or "zh-CN"),
            },
            source_artifact_id=str(params.get("sourceArtifactId") or "").strip(),
            draft_kind="creative_assets" if is_creative_assets else "chapter",
        ))
        self._run_tasks[run.runId] = task
        self._save()
        return run

    async def _revise_draft_guarded(
        self,
        run_id: str,
        invoke_params: dict[str, Any],
        *,
        source_artifact_id: str,
        draft_kind: str = "chapter",
    ) -> None:
        run = self.state.runs.get(run_id)
        if not run:
            return
        plan = self.state.plans.get(run.planId)
        step = plan.steps[0] if plan and plan.steps else None
        is_creative_assets = draft_kind == "creative_assets"
        tool_name = "creative_assets.revise_draft" if is_creative_assets else "chapter.revise_draft"
        artifact_type = "creative_assets_draft" if is_creative_assets else "chapter_draft"
        try:
            if not step:
                raise ValueError("Revision plan step was not found")
            run.currentStepId = step.stepId
            step.status = "running"
            await self._emit(run, "step_started", step_id=step.stepId, agent="writer", status="running", payload={"title": step.title})
            await self._emit(
                run,
                "tool_call",
                step_id=step.stepId,
                agent="writer",
                tool_name=tool_name,
                status="running",
                payload={"summary": "正在根据审批意见生成新版本", "commentCount": len(invoke_params["comments"])},
            )
            result = await self._tool_invoke(run, tool_name, invoke_params)
            if not isinstance(result, dict) or not str(result.get("draftSessionId") or "").strip():
                raise ValueError(f"{tool_name} returned an invalid DraftSession")
            draft_session_id = str(result["draftSessionId"])
            run.draftSessionId = draft_session_id
            await self._emit(
                run,
                "tool_result",
                step_id=step.stepId,
                agent="writer",
                tool_name=tool_name,
                status="completed",
                payload={"summary": "新的待审核版本已生成", "draftSessionId": draft_session_id},
            )
            await self._emit(
                run,
                "draft_created",
                step_id=step.stepId,
                agent="writer",
                tool_name=tool_name,
                status="completed",
                payload={
                    "draftSessionId": draft_session_id,
                    "draftType": artifact_type,
                    "reviewRequestId": invoke_params["reviewRequestId"],
                    "revisionOfDraftSessionId": invoke_params["sourceDraftSessionId"],
                },
            )
            artifact = await self._publish_artifact(
                run,
                artifact_type=artifact_type,
                title="审批意见修订素材" if is_creative_assets else "审批意见修订草稿",
                summary=str(result.get("previewSummary") or "新的待审核版本已生成"),
                reference={"draftSessionId": draft_session_id},
                metadata={
                    "revisionOfDraftSessionId": invoke_params["sourceDraftSessionId"],
                    "reviewRequestId": invoke_params["reviewRequestId"],
                    "sourceArtifactId": source_artifact_id or None,
                    "reviewComments": invoke_params["comments"],
                },
                step_id=step.stepId,
                agent="writer",
                tool_name=tool_name,
            )
            step.status = "completed"
            run.progress = 1
            await self._emit(
                run,
                "step_completed",
                step_id=step.stepId,
                agent="writer",
                status="completed",
                payload={"title": step.title, "artifactId": artifact.artifactId},
            )
            await self._finish_run(
                run,
                "completed",
                "run_completed",
                {"draftSessionId": draft_session_id, "artifactIds": [artifact.artifactId]},
            )
        except asyncio.CancelledError:
            if run.status not in {"completed", "failed", "cancelled"}:
                await asyncio.shield(self._finish_run(run, "cancelled", "run_cancelled", {"reason": "User cancelled active request"}))
        except Exception as error:
            if step:
                step.status = "failed"
            if run.status not in {"completed", "failed", "cancelled"}:
                code = getattr(error, "code", None)
                payload = {"message": str(error), "stage": "review_revision", "code": code}
                await self._emit(run, "error", step_id=step.stepId if step else None, payload=payload)
                await self._finish_run(run, "failed", "run_failed", payload)
        finally:
            self._run_tasks.pop(run_id, None)
            self._active_request_ids.pop(run_id, None)
            self._active_tool_request_ids.pop(run_id, None)

    async def regenerate_batch(self, params: dict[str, Any], context: dict[str, Any]) -> AgentRun:
        draft_batch_id = str(params.get("draftBatchId") or "").strip()
        if not draft_batch_id:
            raise ValueError("draftBatchId is required")
        if params.get("confirmed") is not True:
            raise ValueError("Explicit batch regeneration confirmation is required")
        expected_version = params.get("version")
        if not isinstance(expected_version, int) or expected_version < 1:
            raise ValueError("version must be a positive integer")
        if any(
            run.draftBatchId == draft_batch_id
            and run.status in {"running", "waiting_approval", "cancelling"}
            for run in self.state.runs.values()
        ):
            raise ValueError("Draft batch already has an active run")

        raw_batch = await self.tool_adapter.invoke(
            "draft.batch.get",
            {"draftBatchId": draft_batch_id},
            str(context.get("origin") or "desktop-ui"),
        )
        batch = normalize_draft_batch(raw_batch, "batch.regenerate.read")
        if batch.version != expected_version:
            raise ValueError("Draft batch version conflict")
        if batch.status in {"committed", "discarded"}:
            raise ValueError(f"Cannot regenerate a {batch.status} draft batch")

        requested_index = params.get("fromChildIndex")
        if requested_index is not None and (
            not isinstance(requested_index, int)
            or requested_index < 0
            or requested_index >= len(batch.children)
        ):
            raise ValueError("fromChildIndex is outside the draft batch")
        inferred_index = next((
            child.childIndex
            for child in batch.children
            if child.status in {"stale", "failed", "pending", "generating"}
        ), None)
        from_child_index = requested_index if requested_index is not None else inferred_index
        if from_child_index is None:
            raise ValueError("fromChildIndex is required when every batch child is reviewable")
        if any(child.status == "committed" for child in batch.children[from_child_index:]):
            raise ValueError("Committed batch children cannot be regenerated")
        invalid_prefix = next((
            child for child in batch.children[:from_child_index]
            if child.status not in {"draft", "committed"}
        ), None)
        if invalid_prefix:
            raise ValueError(f"Draft batch child {invalid_prefix.childIndex + 1} must be resolved first")
        unknown_child = next((
            child for child in batch.children[from_child_index:]
            if child.error and child.error.get("sideEffectUnknown")
        ), None)
        if unknown_child:
            raise ValueError(
                f"Draft batch child {unknown_child.childIndex + 1} has an unknown side effect and must be reconciled first"
            )

        goal = str(params.get("goal") or "").strip() or (
            f"从第 {from_child_index + 1} 个章节拍开始重新生成"
            f"{'改写' if batch.mode == 'batch_rewrite' else '连续'}草稿，并保持前序内容不变"
        )
        thread_id = str(params.get("threadId") or "").strip() or new_id("thread")
        step = AgentPlanStep(
            stepId=new_id("step"),
            agent="writer",
            title=f"从第 {from_child_index + 1} 章重新生成{'改写' if batch.mode == 'batch_rewrite' else '批次'}草稿",
            tools=[],
            toolchain=ToolchainInvocation(
                id="chapter.batch_rewrite" if batch.mode == "batch_rewrite" else "chapter.sequence_continuation",
                version="1.0.0",
                input={
                    "chapterCount": len(batch.children),
                    **({
                        "kind": "selected_chapters",
                        "chapterIds": [
                            child.targetChapterId
                            for child in batch.children
                            if child.targetChapterId
                        ],
                        "scopeId": f"scope_rewrite_{batch.draftBatchId}",
                    } if batch.mode == "batch_rewrite" else {}),
                    "beats": [
                        {
                            "title": beat.title,
                            "chapterGoal": beat.chapterGoal,
                            "coreConflict": beat.coreConflict,
                            "keyEvents": beat.keyEvents,
                            "reveals": beat.reveals,
                            "endingHook": beat.endingHook,
                            "targetWordCount": beat.targetWordCount,
                        }
                        for beat in batch.outline.beats
                    ],
                    "insertionMode": batch.insertionMode or "after_anchor",
                    "resumeBatchId": batch.draftBatchId,
                    "resumeBatchVersion": batch.version,
                    "startChildIndex": from_child_index,
                    "contextChapterCount": int(params.get("contextChapterCount") or 8),
                    "recentRawChapterCount": int(params.get("recentRawChapterCount") or 2),
                    "style": str(params.get("style") or ""),
                    "tone": str(params.get("tone") or ""),
                    "pace": str(params.get("pace") or ""),
                },
            ),
        )
        plan = AgentPlan(
            planId=new_id("plan"),
            threadId=thread_id,
            title=f"重新生成多章节草稿（从第 {from_child_index + 1} 章）",
            goal=goal,
            requiresApproval=True,
            steps=[step],
            preferredRole="writer",
            deliverable="chapter_draft_batch",
        )
        self.state.plans[plan.planId] = plan
        run = AgentRun(
            runId=new_id("run"),
            threadId=thread_id,
            planId=plan.planId,
            status="running",
            draftBatchId=batch.draftBatchId,
        )
        self.state.runs[run.runId] = run
        step.status = "pending"
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        await self._emit(
            run,
            "run_started",
            payload={
                "planId": plan.planId,
                "title": plan.title,
                "kind": "batch_regeneration",
                "draftBatchId": batch.draftBatchId,
                "fromChildIndex": from_child_index,
            },
        )
        await self._emit(
            run,
            "plan_approved",
            payload={"approvedStepIds": [step.stepId], "source": "batch_regeneration_confirmation"},
        )
        execution_state = ExecutionState(
            run_id=run.runId,
            approved_step_ids=[step.stepId],
            novel_id=batch.novelId,
            volume_id=batch.volumeId,
            chapter_id=batch.anchorChapterId,
            current_content=str(params.get("currentContent") or ""),
            locale=locale,
            step_index=0,
            tool_index=0,
            phase="start_step",
            action="continue",
            checkpoint=None,
            resume_response=None,
            latest_analysis_summary="",
            report_findings=[],
            creative_direction_checked=False,
            toolchain_state=None,
        )
        task = asyncio.create_task(self._run_graph_guarded(run.runId, initial_state=execution_state))
        self._run_tasks[run.runId] = task
        self._save()
        return run

    async def inspect_side_effect(self, params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        draft_batch_id = str(params.get("draftBatchId") or "").strip()
        if not draft_batch_id:
            raise ValueError("draftBatchId is required")
        child_index = params.get("childIndex")
        generation_revision = params.get("generationRevision")
        if not isinstance(child_index, int) or child_index < 0:
            raise ValueError("childIndex must be a non-negative integer")
        if not isinstance(generation_revision, int) or generation_revision < 1:
            raise ValueError("generationRevision must be a positive integer")

        inspection = await self.automation.invoke(
            "draft.batch.inspect_reconciliation",
            {
                "draftBatchId": draft_batch_id,
                "childIndex": child_index,
                "generationRevision": generation_revision,
            },
            str(context.get("origin") or "desktop-ui"),
            request_id=new_id("automation"),
        )
        if not isinstance(inspection, dict):
            raise ValueError("Invalid draft batch reconciliation inspection")
        batch = inspection.get("batch") if isinstance(inspection.get("batch"), dict) else {}
        child = inspection.get("child") if isinstance(inspection.get("child"), dict) else {}
        reconciliation = child.get("reconciliation") if isinstance(child.get("reconciliation"), dict) else {}
        child_error = child.get("error") if isinstance(child.get("error"), dict) else {}
        invocation_key = str(
            params.get("invocationKey")
            or reconciliation.get("invocationKey")
            or child_error.get("invocationKey")
            or ""
        ).strip()
        if not invocation_key:
            run_ids = {
                str(item)
                for item in [batch.get("runId"), *(batch.get("linkedRunIds") or [])]
                if item
            }
            candidates = [
                item
                for run_id in run_ids
                for item in self.store.list_invocations(run_id, statuses={"unknown"})
                if item.method == "chapter.generate_draft"
            ]
            unique = {item.invocationKey: item for item in candidates}
            if len(unique) == 1:
                invocation_key = next(iter(unique))
        if not invocation_key:
            raise ValueError("The unknown invocation cannot be identified safely")
        invocation = self.store.get_invocation(invocation_key)
        if invocation is None:
            raise ValueError("Invocation ledger record not found")
        expected_method = str(reconciliation.get("method") or child_error.get("method") or "chapter.generate_draft")
        if invocation.method != expected_method:
            raise ValueError("Invocation ledger method does not match the batch child")

        draft_candidates = inspection.get("candidates") if isinstance(inspection.get("candidates"), list) else []
        sanitized_candidates = [
            {
                key: item.get(key)
                for key in (
                    "draftSessionId",
                    "draftBatchId",
                    "childIndex",
                    "generationRevision",
                    "status",
                    "previewSummary",
                    "createdAt",
                    "updatedAt",
                )
            }
            for item in draft_candidates
            if isinstance(item, dict)
        ]
        return {
            "batch": batch,
            "child": child,
            "candidates": sanitized_candidates,
            "invocation": {
                "invocationKey": invocation.invocationKey,
                "requestId": invocation.requestId,
                "runId": invocation.runId,
                "stepId": invocation.stepId,
                "method": invocation.method,
                "status": invocation.status,
                "createdAt": invocation.createdAt,
                "updatedAt": invocation.updatedAt,
                "errorCode": (invocation.error or {}).get("code"),
            },
            "canAcceptExisting": invocation.status == "unknown" and bool(sanitized_candidates),
            "canConfirmAbsent": invocation.status == "unknown",
        }

    async def reconcile_side_effect(self, params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        if params.get("confirmation") is not True:
            raise ValueError("Explicit side-effect reconciliation confirmation is required")
        resolution = str(params.get("resolution") or "")
        if resolution not in {"reconciled_succeeded", "reconciled_absent"}:
            raise ValueError("Unsupported side-effect reconciliation resolution")
        inspection = await self.inspect_side_effect(params, context)
        invocation_data = inspection["invocation"]
        invocation_key = str(invocation_data["invocationKey"])
        invocation = self.store.get_invocation(invocation_key)
        if invocation is None:
            raise ValueError("Invocation ledger record not found")
        if invocation.status not in {"unknown", resolution}:
            raise ValueError(f"Invocation cannot be reconciled from {invocation.status}")

        batch = inspection["batch"]
        child = inspection["child"]
        current_resolution = (
            child.get("reconciliation", {}).get("resolution")
            if isinstance(child.get("reconciliation"), dict)
            else None
        )
        expected_version = params.get("version")
        if not isinstance(expected_version, int) or expected_version < 1:
            raise ValueError("version must be a positive integer")
        if int(batch.get("version") or 0) != expected_version and current_resolution != resolution:
            raise ValueError("Draft batch version conflict")
        candidate_id = str(params.get("candidateDraftSessionId") or "").strip() or None
        if resolution == "reconciled_succeeded":
            matching_ids = {str(item.get("draftSessionId")) for item in inspection["candidates"]}
            if not candidate_id or candidate_id not in matching_ids:
                raise ValueError("A matching draft candidate must be selected")

        if current_resolution != resolution:
            batch = await self.automation.invoke(
                "draft.batch.reconcile_unknown",
                {
                    "draftBatchId": str(batch.get("draftBatchId") or params.get("draftBatchId")),
                    "version": expected_version,
                    "childIndex": int(child.get("childIndex")),
                    "generationRevision": int(child.get("generationRevision")),
                    "invocationKey": invocation_key,
                    "resolution": resolution,
                    "confirmation": True,
                    **({"candidateDraftSessionId": candidate_id} if candidate_id else {}),
                    **({"note": str(params.get("note")).strip()} if params.get("note") else {}),
                },
                str(context.get("origin") or "desktop-ui"),
                request_id=new_id("automation"),
            )

        if invocation.status == "unknown":
            result_snapshot: Any = None
            if resolution == "reconciled_succeeded" and candidate_id:
                candidate = await self.automation.invoke(
                    "draft.get",
                    {"draftSessionId": candidate_id},
                    str(context.get("origin") or "desktop-ui"),
                    request_id=new_id("automation"),
                )
                result_snapshot = self._side_effect_result_snapshot(candidate)
            invocation = self.store.reconcile_invocation(
                invocation_key,
                resolution,
                result=result_snapshot,
                note=str(params.get("note") or "").strip() or None,
            )
        return {
            "batch": batch,
            "resolution": resolution,
            "invocation": {
                "invocationKey": invocation.invocationKey,
                "requestId": invocation.requestId,
                "method": invocation.method,
                "status": invocation.status,
                "updatedAt": invocation.updatedAt,
            },
        }

    async def _run_graph_guarded(
        self,
        run_id: str,
        *,
        initial_state: ExecutionState | None = None,
        resume: dict[str, Any] | None = None,
    ) -> None:
        try:
            await self.execution_graph.run(
                f"run:{run_id}",
                self._advance_execution,
                initial_state=initial_state,
                resume=resume,
            )
        except asyncio.CancelledError:
            run = self.state.runs.get(run_id)
            if run and run.status not in {"completed", "failed", "cancelled"}:
                await asyncio.shield(
                    self._finish_run(run, "cancelled", "run_cancelled", {"reason": "User cancelled active request"})
                )
        except Exception as error:
            run = self.state.runs.get(run_id)
            if run and run.status not in {"completed", "failed", "cancelled"}:
                code = getattr(error, "code", None)
                details = error.failure.payload() if isinstance(error, AgentRequestError) else {}
                failure_payload = {"message": str(error), "stage": "execution_graph", "code": code, **details}
                await self._emit(run, "error", payload=failure_payload)
                await self._finish_run(
                    run,
                    "failed",
                    "run_failed",
                    failure_payload,
                )
        finally:
            self._run_tasks.pop(run_id, None)
            self._active_request_ids.pop(run_id, None)
            self._active_tool_request_ids.pop(run_id, None)

    async def _advance_execution(self, graph_state: ExecutionState) -> dict[str, Any]:
        run = self.state.runs.get(graph_state["run_id"])
        if not run:
            return {"action": "terminal"}
        plan = self.state.plans.get(run.planId)
        if not plan:
            await self._finish_run(run, "failed", "run_failed", {"message": "plan not found"})
            return {"action": "terminal"}
        if run.cancelRequested:
            await self._finish_run(run, "cancelled", "run_cancelled", {"reason": "User cancelled"})
            return {"action": "terminal"}

        approved = set(graph_state["approved_step_ids"])
        steps = [step for step in plan.steps if step.stepId in approved]
        step_index = graph_state["step_index"]
        phase = graph_state["phase"]
        if phase == "start_step":
            if step_index >= len(steps):
                return {"phase": "final_report", "action": "continue", "resume_response": None}
            step = steps[step_index]
            run.currentStepId = step.stepId
            run.progress = step_index / max(1, len(steps))
            step.status = "running"
            await self._emit(run, "step_started", step_id=step.stepId, agent=step.agent, payload={"title": step.title})
            return {
                "phase": "toolchain" if step.toolchain else "before_tool",
                "tool_index": 0,
                "toolchain_state": None,
                "action": "continue",
                "resume_response": None,
            }

        if phase == "final_report":
            try:
                expected_draft = plan.deliverable if plan.deliverable in DRAFT_TOOLS else None
                report_only = self._has_approval_choice(run, "evidence_quality", "report_only")
                if expected_draft and not report_only and not any(
                    artifact.type == expected_draft and artifact.status == "ready" for artifact in run.artifacts
                ):
                    raise ValueError(f"Required Agent artifact was not produced: {expected_draft}")
                report = await self._automation_invoke(
                    run,
                    "agent.generate_report",
                    {
                        "goal": plan.goal,
                        "planTitle": plan.title,
                        "role": plan.preferredRole,
                        "locale": graph_state["locale"],
                        "steps": [{"agent": step.agent, "title": step.title, "status": step.status} for step in steps],
                        "findings": graph_state["report_findings"],
                        "approvalResponses": run.approvalResponses,
                        "draftSessionId": run.draftSessionId,
                        "deliverable": plan.deliverable,
                    },
                    node_id="final_report",
                )
                content = str(report.get("content") or "").strip() if isinstance(report, dict) else ""
                if not content:
                    raise ValueError("Agent final report returned empty content")
                conversation_summary = (
                    str(report.get("conversationSummary") or "").strip()
                    if isinstance(report, dict)
                    else ""
                ) or content
                report_artifact = await self._publish_artifact(
                    run,
                    artifact_type="report",
                    title=f"{plan.title} - 最终报告",
                    summary=content[:240],
                    content=content,
                    metadata={"role": plan.preferredRole, "deliverable": plan.deliverable},
                    agent=steps[-1].agent if steps else "supervisor",
                )
                await self._emit(
                    run,
                    "message",
                    agent=steps[-1].agent if steps else "supervisor",
                    status="completed",
                    payload={
                        "kind": "final_report",
                        "content": conversation_summary,
                        "reportArtifactId": report_artifact.artifactId,
                    },
                )
                run.currentStepId = None
                run.progress = 1
                await self._finish_run(
                    run,
                    "completed",
                    "run_completed",
                    {
                        "draftSessionId": run.draftSessionId,
                        "artifactIds": [artifact.artifactId for artifact in run.artifacts],
                        "reportArtifactId": report_artifact.artifactId,
                    },
                )
            except Exception as error:
                details = error.failure.payload() if isinstance(error, AgentRequestError) else {}
                payload = {
                    "message": str(error),
                    "stage": "final_report",
                    "code": getattr(error, "code", None),
                    **details,
                }
                await self._emit(run, "error", payload=payload)
                await self._finish_run(run, "failed", "run_failed", payload)
            return {"action": "terminal"}

        if step_index >= len(steps):
            return {"phase": "final_report", "action": "continue"}
        step = steps[step_index]
        tool_index = graph_state["tool_index"]

        if phase == "toolchain":
            try:
                return await self._advance_toolchain(run, plan, step, graph_state)
            except ToolchainError as error:
                step.status = "failed"
                payload = {**error.payload(), "toolchain": step.toolchain.model_dump() if step.toolchain else None}
                await self._emit(run, "toolchain_failed", step_id=step.stepId, agent=step.agent, status="failed", payload=payload)
                await self._emit(run, "error", step_id=step.stepId, agent=step.agent, payload=payload)
                await self._emit(
                    run,
                    "step_failed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="failed",
                    payload={"title": step.title, "message": str(error), "code": error.code},
                )
                await self._finish_run(run, "failed", "run_failed", {"message": str(error), "code": error.code})
                return {"action": "terminal"}

        if phase == "finish_step" or tool_index >= len(step.tools):
            step.status = "completed"
            await self._emit(run, "step_completed", step_id=step.stepId, agent=step.agent, status="completed", payload={"title": step.title})
            return {
                "step_index": step_index + 1,
                "tool_index": 0,
                "phase": "start_step",
                "action": "continue",
                "resume_response": None,
                "toolchain_state": None,
            }

        tool_name = step.tools[tool_index]
        if tool_name in {"chapter.generate_draft", "creative_assets.generate_draft"} and self._has_approval_choice(
            run, "evidence_quality", "report_only"
        ):
            await self._emit(
                run,
                "tool_result",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="skipped",
                payload={"summary": "用户选择只保留分析报告，已跳过草稿生成。", "reason": "report_only"},
            )
            return {"tool_index": tool_index + 1, "action": "continue", "resume_response": None}

        if tool_name == "rag.ask" and not any(
            response.get("checkpointType") == "analysis_scope" for response in run.approvalResponses
        ):
            checkpoint = self._analysis_scope_checkpoint(step.stepId)
            await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
            return {"checkpoint": checkpoint, "action": "waiting_approval", "resume_response": None}

        creative_checked = graph_state["creative_direction_checked"]
        if tool_name in {"chapter.generate_draft", "creative_assets.generate_draft"} and not creative_checked:
            checkpoint = await self._creative_direction_checkpoint(
                run,
                step.stepId,
                plan.goal,
                plan.title,
                step.title,
                graph_state["latest_analysis_summary"],
                graph_state["locale"],
            )
            if checkpoint:
                await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                return {
                    "checkpoint": checkpoint,
                    "creative_direction_checked": True,
                    "action": "waiting_approval",
                    "resume_response": None,
                }
            creative_checked = True

        try:
            await self._emit(
                run,
                "tool_call",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="running",
                payload={"summary": f"正在调用 {tool_name}", "transport": self.tool_transport},
            )
            result = await self._invoke_tool(
                run,
                tool_name,
                plan.goal,
                graph_state["novel_id"],
                graph_state["volume_id"],
                graph_state["chapter_id"],
                graph_state["current_content"],
                graph_state["locale"],
            )
            summary = self._summarize_result(tool_name, result)
            findings = [
                *graph_state["report_findings"],
                {"toolName": tool_name, "stepTitle": step.title, "data": self._compact_report_result(result)},
            ]
            if isinstance(result, dict) and result.get("draftSessionId"):
                run.draftSessionId = str(result.get("draftSessionId"))
                await self._emit(
                    run,
                    "draft_created",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=tool_name,
                    status="completed",
                    payload={
                        "draftSessionId": run.draftSessionId,
                        "draftType": result.get("type"),
                        "previewSummary": result.get("previewSummary"),
                    },
                )
                artifact_type = "chapter_draft" if tool_name == "chapter.generate_draft" else "creative_assets_draft"
                await self._publish_artifact(
                    run,
                    artifact_type=artifact_type,
                    title="章节修改草稿" if artifact_type == "chapter_draft" else "创作素材草稿",
                    summary=str(result.get("previewSummary") or summary)[:500],
                    reference={"draftSessionId": run.draftSessionId},
                    metadata={"toolName": tool_name, "draftType": result.get("type")},
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=tool_name,
                )
            await self._emit(
                run,
                "tool_result",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={"summary": summary, "transport": self.tool_transport},
            )
            update: dict[str, Any] = {
                "tool_index": tool_index + 1,
                "report_findings": findings,
                "creative_direction_checked": creative_checked,
                "action": "continue",
                "resume_response": None,
            }
            if tool_name == "rag.ask":
                update["latest_analysis_summary"] = summary
                later_tools = step.tools[tool_index + 1:] + [tool for later in steps[step_index + 1:] for tool in later.tools]
                checkpoint = self._evidence_quality_checkpoint(step.stepId, result) if any(
                    item in {"chapter.generate_draft", "creative_assets.generate_draft"} for item in later_tools
                ) else None
                if checkpoint:
                    await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                    update.update({"checkpoint": checkpoint, "action": "waiting_approval"})
            return update
        except Exception as error:
            step.status = "failed"
            code = getattr(error, "code", None)
            details = error.failure.payload() if isinstance(error, AgentRequestError) else {}
            await self._emit(
                run,
                "error",
                step_id=step.stepId,
                agent=step.agent,
                payload={"message": str(error), "code": code, **details},
            )
            await self._emit(
                run,
                "step_failed",
                step_id=step.stepId,
                agent=step.agent,
                status="failed",
                payload={"title": step.title, "message": str(error), "code": code},
            )
            await self._finish_run(run, "failed", "run_failed", {"message": str(error), "code": code, **details})
            return {"action": "terminal"}

    async def _advance_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Toolchain phase has no invocation")
        role = "team" if step.agent == "supervisor" else step.agent
        definition = TOOLCHAIN_REGISTRY.resolve(invocation.id, invocation.version, role)
        chain_state = graph_state.get("toolchain_state")
        if chain_state is None:
            raw_input = {
                **invocation.input,
                "novelId": graph_state["novel_id"],
                "chapterId": graph_state["chapter_id"],
                "volumeId": graph_state["volume_id"],
                "goal": plan.goal,
                "locale": graph_state["locale"],
                "currentContent": graph_state["current_content"],
            }
            try:
                validated_input = definition.inputModel.model_validate(raw_input)
            except ValidationError as error:
                raise ToolchainError(
                    "INPUT_INVALID",
                    f"Invalid input for {invocation.id}: {error.errors(include_url=False)}",
                    details={"errors": error.errors(include_url=False)},
                ) from error
            if invocation.id in {"chapter.sequence_continuation", "chapter.batch_rewrite"}:
                chain_state = {}
            elif invocation.id == "creative_asset.draft":
                creative_input = CreativeAssetDraftInput.model_validate(validated_input.model_dump())
                chain_state = initial_creative_asset_state(creative_input)
            elif invocation.id == "plotline.analysis":
                plotline_input = PlotlineAnalysisInput.model_validate(validated_input.model_dump())
                chain_state = initial_plotline_analysis_state(plotline_input)
            elif invocation.id in {
                "chapter.scope_context",
                "writer.range_revision_plan",
                "editor.range_review",
                "reader.journey_review",
                "worldbuilding.range_consistency",
                "research.range_fact_check",
                "novel.scope_audit",
            }:
                scope_input = ChapterScopeContextInput.model_validate(validated_input.model_dump())
                chain_state = initial_scope_context_state(scope_input)
            else:
                context_input = ChapterContextInput.model_validate(validated_input.model_dump())
                chain_state = initial_context_state(context_input)
            chain_state = {
                **chain_state,
                "toolchainId": invocation.id,
                "version": invocation.version,
                "toolchainInput": validated_input.model_dump(),
                "reviewCompleted": False,
            }
            await self._emit(
                run,
                "toolchain_started",
                step_id=step.stepId,
                agent=step.agent,
                status="running",
                payload={
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                    "title": definition.title,
                    "sideEffect": definition.sideEffect,
                    "budget": definition.budget.model_dump(),
                },
            )
            return {"toolchain_state": chain_state, "action": "continue", "resume_response": None}

        if invocation.id == "creative_asset.draft":
            return await self._advance_creative_asset_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
            )
        if invocation.id == "plotline.analysis":
            return await self._advance_plotline_analysis_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
            )
        if invocation.id in {
            "chapter.scope_context",
            "writer.range_revision_plan",
            "editor.range_review",
            "reader.journey_review",
            "worldbuilding.range_consistency",
            "research.range_fact_check",
            "novel.scope_audit",
        }:
            return await self._advance_chapter_scope_context_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
            )
        if invocation.id == "chapter.continuation":
            return await self._advance_chapter_continuation_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
            )
        if invocation.id in {"chapter.sequence_continuation", "chapter.batch_rewrite"}:
            return await self._advance_chapter_sequence_continuation_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
            )

        node_index = int(chain_state.get("nodeIndex") or 0)
        if node_index < len(CONTEXT_NODES):
            node_id = CONTEXT_NODES[node_index]
            call_count = int(chain_state.get("toolCallCount") or 0)
            estimated_tokens = int(chain_state.get("estimatedTokens") or 0)
            input_budget = chain_state.get("toolchainInput", {}).get("maxEstimatedTokens")
            max_tokens = min(definition.budget.maxEstimatedTokens, int(input_budget)) if input_budget else definition.budget.maxEstimatedTokens
            if call_count >= definition.budget.maxToolCalls or estimated_tokens >= max_tokens:
                reason = (
                    f"Toolchain 预算已用尽，跳过剩余资料源：calls {call_count}/{definition.budget.maxToolCalls}, "
                    f"tokens {estimated_tokens}/{max_tokens}。"
                )
                updated = exhaust_context_budget(chain_state, reason)
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="skipped",
                    payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": reason, "code": "BUDGET_EXCEEDED"},
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            call = build_tool_call(node_id, chain_state)
            if call is None:
                reason = f"{node_id} 缺少可用的定位参数，已作为部分结果跳过。"
                updated = apply_node_skip(chain_state, node_id, reason)
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="skipped",
                    payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": reason},
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            tool_name, args = call
            if tool_name not in definition.requiredTools:
                raise ToolchainError(
                    "TOOL_NOT_ALLOWED",
                    f"Tool {tool_name} is not registered for {invocation.id}@{invocation.version}",
                    node_id=node_id,
                )
            await self._emit(
                run,
                "toolchain_node_started",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="running",
                payload={"toolchainId": invocation.id, "version": invocation.version, "nodeId": node_id},
            )
            await self._emit(
                run,
                "tool_call",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="running",
                payload={
                    "summary": f"正在调用 {tool_name}",
                    "transport": self.tool_transport,
                    "args": args,
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                },
            )
            try:
                result = await self._tool_invoke(run, tool_name, args)
                updated = apply_node_result(chain_state, node_id, result)
                summary = self._summarize_result(tool_name, result)
                await self._emit(
                    run,
                    "tool_result",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=tool_name,
                    status="completed",
                    payload={
                        "summary": summary,
                        "transport": self.tool_transport,
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                    },
                )
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=tool_name,
                    status="completed",
                    payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
                )
            except Exception as error:
                await self._emit(
                    run,
                    "tool_result",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=tool_name,
                    status="failed",
                    payload={
                        "summary": str(error),
                        "transport": self.tool_transport,
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                    },
                )
                updated = apply_node_failure(chain_state, node_id, error)
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=tool_name,
                    status="partial",
                    payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": str(error)},
                )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        context_bundle = build_context_bundle(chain_state)
        if invocation.id == "chapter.consistency_review" and not chain_state.get("reviewCompleted"):
            node_id = "review.synthesize"
            await self._emit(
                run,
                "toolchain_node_started",
                step_id=step.stepId,
                agent=step.agent,
                status="running",
                payload={"toolchainId": invocation.id, "version": invocation.version, "nodeId": node_id, "kind": "model"},
            )
            try:
                toolchain_input = chain_state.get("toolchainInput") or {}
                raw_review = await self._automation_invoke(
                    run,
                    "agent.generate_consistency_review",
                    review_request(
                        plan.goal,
                        graph_state["locale"],
                        context_bundle,
                        list(toolchain_input.get("dimensions") or []),
                    ),
                )
                review = normalize_review(raw_review, context_bundle)
            except Exception as error:
                raise ToolchainError(
                    "NODE_FAILED",
                    f"Consistency review synthesis failed: {error}",
                    node_id=node_id,
                    retryable=True,
                ) from error
            artifact = await self._publish_artifact(
                run,
                artifact_type="consistency_review",
                title="章节一致性审核",
                summary=review.summary[:500],
                content=review_markdown(review),
                reference={
                    "chapterId": graph_state["chapter_id"],
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                },
                metadata={"review": review.model_dump(), "contextBundle": context_bundle.model_dump()},
                step_id=step.stepId,
                agent=step.agent,
            )
            updated = {
                **chain_state,
                "reviewCompleted": True,
                "review": review.model_dump(),
                "artifactId": artifact.artifactId,
            }
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": review.summary[:240],
                    "artifactId": artifact.artifactId,
                },
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if invocation.id == "chapter.context":
            artifact = await self._publish_artifact(
                run,
                artifact_type="context_bundle",
                title="章节上下文包",
                summary=f"读取 {context_bundle.toolCallCount} 项资料，估算 {context_bundle.estimatedTokens} tokens。",
                content=json.dumps(context_bundle.model_dump(), ensure_ascii=False, indent=2),
                reference={
                    "chapterId": graph_state["chapter_id"],
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                },
                metadata={"contextBundle": context_bundle.model_dump()},
                step_id=step.stepId,
                agent=step.agent,
            )
            output: Any = context_bundle.model_dump()
        else:
            artifact = next(
                (item for item in run.artifacts if item.artifactId == chain_state.get("artifactId")),
                None,
            )
            output = chain_state.get("review") or {}
        await self._emit(
            run,
            "toolchain_completed",
            step_id=step.stepId,
            agent=step.agent,
            status="completed",
            payload={
                "toolchainId": invocation.id,
                "version": invocation.version,
                "title": definition.title,
                "artifactId": artifact.artifactId if artifact else None,
                "toolCallCount": context_bundle.toolCallCount,
                "estimatedTokens": context_bundle.estimatedTokens,
            },
        )
        findings = [
            *graph_state["report_findings"],
            {
                "toolName": f"toolchain:{invocation.id}@{invocation.version}",
                "stepTitle": step.title,
                "data": self._compact_report_result(output),
            },
        ]
        return {
            "phase": "finish_step",
            "report_findings": findings,
            "toolchain_state": chain_state,
            "action": "continue",
            "resume_response": None,
        }

    async def _advance_chapter_scope_context_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
        chain_state: dict[str, Any],
        definition: Any,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Chapter scope context has no Toolchain invocation")

        scope_nodes = ("scope.read",) if invocation.id == "reader.journey_review" else SCOPE_CONTEXT_NODES
        node_index = int(chain_state.get("nodeIndex") or 0)
        if node_index < len(scope_nodes):
            node_id = scope_nodes[node_index]
            call_count = int(chain_state.get("toolCallCount") or 0)
            estimated_tokens = int(chain_state.get("estimatedTokens") or 0)
            input_budget = chain_state.get("toolchainInput", {}).get("maxEstimatedTokens")
            max_tokens = (
                min(definition.budget.maxEstimatedTokens, int(input_budget))
                if input_budget
                else definition.budget.maxEstimatedTokens
            )
            if call_count >= definition.budget.maxToolCalls:
                raise ToolchainError(
                    "BUDGET_EXCEEDED",
                    f"多章节范围上下文已用尽工具预算：{call_count}/{definition.budget.maxToolCalls}。",
                    node_id=node_id,
                )
            if node_id == "rag.retrieve" and estimated_tokens >= max_tokens:
                reason = "范围基础包已达到上下文预算，跳过补充 RAG 检索。"
                updated = {
                    **chain_state,
                    "nodeIndex": node_index + 1,
                    "warnings": [*(chain_state.get("warnings") or []), reason],
                    "sourceStatus": {**(chain_state.get("sourceStatus") or {}), node_id: "skipped"},
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="skipped",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": reason,
                        "code": "BUDGET_EXCEEDED",
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            tool_name, params = build_scope_tool_call(node_id, chain_state)
            self._require_toolchain_tool(definition, tool_name, node_id)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                result = await self._tool_invoke(run, tool_name, params)
                updated = apply_scope_node_result(chain_state, node_id, result)
                summary = self._summarize_result(tool_name, result)
                status = "completed"
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                updated = apply_scope_node_failure(chain_state, node_id, error)
                summary = str(error)
                status = "partial"
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status=status,
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        role = "team" if step.agent == "supervisor" else step.agent
        bundle = build_scope_bundle(chain_state, role)
        artifact_id = str(chain_state.get("artifactId") or "") or None
        if invocation.id == "reader.journey_review":
            chapter_by_id = {chapter.chapterId: chapter for chapter in bundle.chapters if chapter.target}
            chapters = [
                chapter_by_id[chapter_id]
                for chapter_id in bundle.scope.chapterIds
                if chapter_id in chapter_by_id
            ]
            reader_index = int(chain_state.get("readerIndex") or 0)
            evaluations = [
                ReaderChapterEvaluation.model_validate(item)
                for item in (chain_state.get("readerEvaluations") or [])
            ]
            if reader_index < len(chapters):
                model_call_count = int(chain_state.get("modelCallCount") or 0)
                if model_call_count >= definition.budget.maxModelCalls:
                    raise ToolchainError(
                        "BUDGET_EXCEEDED",
                        f"读者顺序盲测已用尽模型预算：{model_call_count}/{definition.budget.maxModelCalls}。",
                        node_id=f"reader.evaluate.{reader_index + 1}",
                    )
                chapter = chapters[reader_index]
                node_id = f"reader.evaluate.{reader_index + 1}"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    ReaderJourneyReviewInput.model_validate(chain_state.get("toolchainInput") or {})
                    raw_evaluation = await self._automation_invoke(
                        run,
                        "agent.generate_reader_chapter_evaluation",
                        reader_chapter_request(
                            graph_state["locale"],
                            chapter,
                            str(chain_state.get("readerState") or ""),
                            reader_index,
                            len(chapters),
                        ),
                    )
                    evaluation = normalize_reader_chapter_evaluation(raw_evaluation, chapter)
                except Exception as error:
                    raise ToolchainError(
                        "NODE_FAILED",
                        f"Reader journey evaluation failed for {chapter.chapterId}: {error}",
                        node_id=node_id,
                        retryable=True,
                    ) from error
                evaluations.append(evaluation)
                updated = {
                    **chain_state,
                    "readerIndex": reader_index + 1,
                    "readerEvaluations": [item.model_dump() for item in evaluations],
                    "readerState": evaluation.readerStateSummary,
                    "modelCallCount": model_call_count + 1,
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": evaluation.summary[:240],
                        "chapterId": chapter.chapterId,
                        "chapterIndex": reader_index + 1,
                        "chapterCount": len(chapters),
                        "retentionScore": evaluation.retentionScore,
                        "dropRisk": evaluation.dropRisk,
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            if not chain_state.get("reviewCompleted"):
                journey = build_reader_journey_artifact(evaluations, bundle)
                artifact_id = new_id("artifact")
                report = ExpertReportPayload(
                    artifactId=artifact_id,
                    novelId=bundle.scope.novelId,
                    runId=run.runId,
                    planId=run.planId,
                    type="reader_journey",
                    title="读者多章节顺序盲测",
                    expert="reader",
                    scope=bundle.scope,
                    findings=[
                        ExpertFinding(
                            findingId=finding.findingId,
                            title=finding.title,
                            summary=finding.summary,
                            category=finding.category,
                            severity=finding.severity,
                            chapterIds=finding.chapterIds,
                            expert="reader",
                            evidenceRefs=finding.evidenceRefs,
                            evidence=finding.evidence,
                            recommendation=finding.recommendation or None,
                            recommendedRole=finding.recommendedRole,
                            uncertainty=finding.uncertainty or None,
                        )
                        for finding in journey.findings
                    ],
                    sourceSnapshot=bundle.sourceSnapshot or bundle.scope.snapshot,
                    coverage=bundle.coverage,
                    summary=journey.summary,
                    generatedAt=utc_now(),
                )
                artifact = await self._publish_artifact(
                    run,
                    artifact_id=artifact_id,
                    artifact_type="reader_journey",
                    title=report.title,
                    summary=journey.summary[:500],
                    content=reader_journey_markdown(journey),
                    reference={
                        "novelId": bundle.scope.novelId,
                        "volumeId": bundle.scope.volumeId,
                        "chapterId": bundle.scope.anchorChapterId,
                        "scopeId": bundle.scope.scopeId,
                        "scopeKind": bundle.scope.kind,
                        "toolchainId": invocation.id,
                        "version": invocation.version,
                    },
                    metadata={
                        "expertReport": report.model_dump(),
                        "readerJourney": journey.model_dump(),
                        "contextStats": {
                            "toolCallCount": int(chain_state.get("toolCallCount") or 0),
                            "modelCallCount": int(chain_state.get("modelCallCount") or 0),
                            "estimatedTokens": bundle.estimatedTokens,
                            "coverage": bundle.coverage.model_dump(),
                        },
                    },
                    step_id=step.stepId,
                    agent=step.agent,
                )
                updated = {
                    **chain_state,
                    "reviewCompleted": True,
                    "artifactId": artifact.artifactId,
                    "output": report.model_dump(),
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": "reader.aggregate",
                        "summary": journey.summary[:240],
                        "artifactId": artifact.artifactId,
                        "findingCount": len(journey.findings),
                        "chapterCount": len(journey.chapters),
                        "coverage": bundle.coverage.model_dump(),
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            return await self._complete_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
                chain_state.get("output") or {},
                artifact_id=artifact_id,
                tool_call_count=int(chain_state.get("toolCallCount") or 0),
            )
        if invocation.id == "novel.scope_audit":
            input_data = ScopeAuditInput.model_validate(chain_state.get("toolchainInput") or {})
            selected_experts = list(input_data.experts)
            completed_experts = set(chain_state.get("auditCompletedExperts") or [])
            failed_experts = dict(chain_state.get("auditFailedExperts") or {})
            child_reports = dict(chain_state.get("auditChildReports") or {})
            expert_refs = dict(chain_state.get("auditExpertRefs") or {})
            model_call_count = int(chain_state.get("modelCallCount") or 0)

            simple_pending = [
                expert for expert in selected_experts
                if expert in {"editor", "worldbuilding"}
                and expert not in completed_experts
                and expert not in failed_experts
            ]
            if simple_pending:
                batch = simple_pending[:input_data.maxConcurrency]
                if model_call_count + len(batch) > definition.budget.maxModelCalls:
                    raise ToolchainError(
                        "BUDGET_EXCEEDED",
                        "团队审计已用尽专家模型预算。",
                        node_id="audit.expert_batch",
                    )
                for expert in batch:
                    await self._emit(
                        run,
                        "toolchain_node_started",
                        step_id=step.stepId,
                        agent=expert,
                        status="running",
                        payload={
                            "toolchainId": invocation.id,
                            "version": invocation.version,
                            "nodeId": f"audit.{expert}",
                            "kind": "model",
                            "batchSize": len(batch),
                            "maxConcurrency": input_data.maxConcurrency,
                        },
                    )

                async def generate_simple_expert(expert: str) -> Any:
                    if expert == "editor":
                        raw = await self._automation_invoke(
                            run,
                            "agent.generate_editor_range_review",
                            editor_range_review_request(plan.goal, graph_state["locale"], bundle, []),
                        )
                        return normalize_editor_range_review(raw, bundle)
                    raw = await self._automation_invoke(
                        run,
                        "agent.generate_worldbuilding_range_consistency",
                        worldbuilding_consistency_request(plan.goal, graph_state["locale"], bundle, []),
                    )
                    return normalize_worldbuilding_consistency(raw, bundle)

                results = await asyncio.gather(
                    *(generate_simple_expert(expert) for expert in batch),
                    return_exceptions=True,
                )
                for expert, result in zip(batch, results, strict=True):
                    node_id = f"audit.{expert}"
                    if isinstance(result, BaseException):
                        failed_experts[expert] = str(result)
                        await self._emit(
                            run,
                            "toolchain_node_completed",
                            step_id=step.stepId,
                            agent=expert,
                            status="failed",
                            payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": str(result)},
                        )
                        continue
                    if expert == "editor":
                        root_findings = [
                            ExpertFinding(
                                findingId=finding.findingId,
                                title=finding.title,
                                summary=finding.summary,
                                category=finding.category,
                                severity=finding.severity,
                                chapterIds=finding.chapterIds,
                                expert="editor",
                                evidenceRefs=finding.evidenceRefs,
                                evidence=finding.evidence,
                                recommendation=finding.recommendation or None,
                                recommendedRole=finding.recommendedRole,
                                uncertainty=finding.uncertainty or None,
                            )
                            for finding in result.findings
                        ]
                        report, _, expert_ref = await self._publish_scope_audit_child(
                            run,
                            step,
                            invocation,
                            bundle,
                            expert="editor",
                            artifact_type="chapter_range_review",
                            title="编辑多章节范围审核",
                            summary=result.summary,
                            content=editor_range_review_markdown(result),
                            findings=root_findings,
                            metadata_key="editorReview",
                            metadata_value=result.model_dump(),
                        )
                    else:
                        root_findings = [
                            ExpertFinding(
                                findingId=finding.findingId,
                                title=finding.title,
                                summary=finding.summary,
                                category=finding.category,
                                severity=finding.severity,
                                chapterIds=finding.chapterIds,
                                expert="worldbuilding",
                                evidenceRefs=finding.evidenceRefs,
                                evidence=finding.evidence,
                                recommendation=finding.recommendation or None,
                                recommendedRole=finding.recommendedRole,
                                uncertainty=finding.uncertainty or None,
                            )
                            for finding in result.findings
                        ]
                        report, _, expert_ref = await self._publish_scope_audit_child(
                            run,
                            step,
                            invocation,
                            bundle,
                            expert="worldbuilding",
                            artifact_type="worldbuilding_consistency",
                            title="世界观多章节一致性审核",
                            summary=result.summary,
                            content=worldbuilding_consistency_markdown(result),
                            findings=root_findings,
                            metadata_key="worldbuildingConsistency",
                            metadata_value=result.model_dump(),
                        )
                    child_reports[expert] = report.model_dump()
                    expert_refs[expert] = expert_ref.model_dump()
                    completed_experts.add(expert)
                    await self._emit(
                        run,
                        "toolchain_node_completed",
                        step_id=step.stepId,
                        agent=expert,
                        status="completed",
                        payload={
                            "toolchainId": invocation.id,
                            "nodeId": node_id,
                            "summary": report.summary or "专家报告已完成。",
                            "artifactId": report.artifactId,
                            "findingCount": len(report.findings),
                        },
                    )
                updated = {
                    **chain_state,
                    "auditCompletedExperts": sorted(completed_experts),
                    "auditFailedExperts": failed_experts,
                    "auditChildReports": child_reports,
                    "auditExpertRefs": expert_refs,
                    "modelCallCount": model_call_count + len(batch),
                }
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            if (
                "reader" in selected_experts
                and "reader" not in completed_experts
                and "reader" not in failed_experts
            ):
                chapter_by_id = {chapter.chapterId: chapter for chapter in bundle.chapters if chapter.target}
                chapters = [
                    chapter_by_id[chapter_id]
                    for chapter_id in bundle.scope.chapterIds
                    if chapter_id in chapter_by_id
                ]
                reader_index = int(chain_state.get("auditReaderIndex") or 0)
                evaluations = [
                    ReaderChapterEvaluation.model_validate(item)
                    for item in (chain_state.get("auditReaderEvaluations") or [])
                ]
                if reader_index < len(chapters):
                    if model_call_count >= definition.budget.maxModelCalls:
                        raise ToolchainError("BUDGET_EXCEEDED", "团队审计已用尽模型预算。", node_id="audit.reader")
                    chapter = chapters[reader_index]
                    node_id = f"audit.reader.{reader_index + 1}"
                    await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                    try:
                        raw = await self._automation_invoke(
                            run,
                            "agent.generate_reader_chapter_evaluation",
                            reader_chapter_request(
                                graph_state["locale"],
                                chapter,
                                str(chain_state.get("auditReaderState") or ""),
                                reader_index,
                                len(chapters),
                            ),
                        )
                        evaluation = normalize_reader_chapter_evaluation(raw, chapter)
                    except Exception as error:
                        failed_experts["reader"] = str(error)
                        updated = {
                            **chain_state,
                            "auditFailedExperts": failed_experts,
                            "modelCallCount": model_call_count + 1,
                        }
                        await self._emit(
                            run,
                            "toolchain_node_completed",
                            step_id=step.stepId,
                            agent="reader",
                            status="failed",
                            payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": str(error)},
                        )
                        return {"toolchain_state": updated, "action": "continue", "resume_response": None}
                    evaluations.append(evaluation)
                    updated = {
                        **chain_state,
                        "auditReaderIndex": reader_index + 1,
                        "auditReaderEvaluations": [item.model_dump() for item in evaluations],
                        "auditReaderState": evaluation.readerStateSummary,
                        "modelCallCount": model_call_count + 1,
                    }
                    await self._emit(
                        run,
                        "toolchain_node_completed",
                        step_id=step.stepId,
                        agent="reader",
                        status="completed",
                        payload={
                            "toolchainId": invocation.id,
                            "nodeId": node_id,
                            "summary": evaluation.summary[:240],
                            "chapterId": chapter.chapterId,
                            "chapterIndex": reader_index + 1,
                            "chapterCount": len(chapters),
                        },
                    )
                    return {"toolchain_state": updated, "action": "continue", "resume_response": None}

                journey = build_reader_journey_artifact(evaluations, bundle)
                root_findings = [
                    ExpertFinding(
                        findingId=finding.findingId,
                        title=finding.title,
                        summary=finding.summary,
                        category=finding.category,
                        severity=finding.severity,
                        chapterIds=finding.chapterIds,
                        expert="reader",
                        evidenceRefs=finding.evidenceRefs,
                        evidence=finding.evidence,
                        recommendation=finding.recommendation or None,
                        recommendedRole=finding.recommendedRole,
                        uncertainty=finding.uncertainty or None,
                    )
                    for finding in journey.findings
                ]
                report, _, expert_ref = await self._publish_scope_audit_child(
                    run,
                    step,
                    invocation,
                    bundle,
                    expert="reader",
                    artifact_type="reader_journey",
                    title="读者多章节顺序盲测",
                    summary=journey.summary,
                    content=reader_journey_markdown(journey),
                    findings=root_findings,
                    metadata_key="readerJourney",
                    metadata_value=journey.model_dump(),
                )
                child_reports["reader"] = report.model_dump()
                expert_refs["reader"] = expert_ref.model_dump()
                completed_experts.add("reader")
                updated = {
                    **chain_state,
                    "auditCompletedExperts": sorted(completed_experts),
                    "auditChildReports": child_reports,
                    "auditExpertRefs": expert_refs,
                }
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            if (
                "research_rag" in selected_experts
                and "research_rag" not in completed_experts
                and "research_rag" not in failed_experts
            ):
                research_claims = [
                    ResearchExtractedClaim.model_validate(item)
                    for item in (chain_state.get("auditResearchClaims") or [])
                ]
                research_evidence = {
                    claim_id: [ContextEvidence.model_validate(item) for item in items]
                    for claim_id, items in (chain_state.get("auditResearchEvidence") or {}).items()
                }
                if not chain_state.get("auditResearchClaimsExtracted"):
                    if model_call_count >= definition.budget.maxModelCalls:
                        raise ToolchainError("BUDGET_EXCEEDED", "团队审计已用尽模型预算。", node_id="audit.research.extract")
                    node_id = "audit.research.extract"
                    await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                    try:
                        raw = await self._automation_invoke(
                            run,
                            "agent.extract_research_claims",
                            research_claim_extraction_request(
                                plan.goal,
                                graph_state["locale"],
                                bundle,
                                input_data.researchMaxClaims,
                            ),
                        )
                        extraction = normalize_research_claims(raw, bundle, input_data.researchMaxClaims)
                    except Exception as error:
                        failed_experts["research_rag"] = str(error)
                        updated = {
                            **chain_state,
                            "auditFailedExperts": failed_experts,
                            "modelCallCount": model_call_count + 1,
                        }
                        await self._emit(
                            run,
                            "toolchain_node_completed",
                            step_id=step.stepId,
                            agent="research_rag",
                            status="failed",
                            payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": str(error)},
                        )
                        return {"toolchain_state": updated, "action": "continue", "resume_response": None}
                    queue = [
                        claim.claimId for claim in extraction.claims
                        if claim.needsProjectSearch and claim.searchKeyword
                    ][:input_data.researchMaxProjectSearches]
                    updated = {
                        **chain_state,
                        "auditResearchClaimsExtracted": True,
                        "auditResearchClaims": [item.model_dump() for item in extraction.claims],
                        "auditResearchWarnings": extraction.warnings,
                        "auditResearchQueue": queue,
                        "auditResearchIndex": 0,
                        "auditResearchEvidence": {},
                        "modelCallCount": model_call_count + 1,
                    }
                    await self._emit(
                        run,
                        "toolchain_node_completed",
                        step_id=step.stepId,
                        agent="research_rag",
                        status="completed",
                        payload={
                            "toolchainId": invocation.id,
                            "nodeId": node_id,
                            "summary": f"已提取 {len(extraction.claims)} 条声明。",
                        },
                    )
                    return {"toolchain_state": updated, "action": "continue", "resume_response": None}

                queue = [str(item) for item in (chain_state.get("auditResearchQueue") or [])]
                search_index = int(chain_state.get("auditResearchIndex") or 0)
                if search_index < len(queue):
                    claim_id = queue[search_index]
                    claim = next((item for item in research_claims if item.claimId == claim_id), None)
                    if claim is None:
                        updated = {**chain_state, "auditResearchIndex": search_index + 1}
                        return {"toolchain_state": updated, "action": "continue", "resume_response": None}
                    tool_call_count = int(chain_state.get("toolCallCount") or 0)
                    node_id = f"audit.research.search.{search_index + 1}"
                    if tool_call_count >= definition.budget.maxToolCalls:
                        raise ToolchainError("BUDGET_EXCEEDED", "团队审计已用尽工具预算。", node_id=node_id)
                    params = research_search_params(bundle.scope.novelId, claim)
                    self._require_toolchain_tool(definition, "search.query", node_id)
                    await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name="search.query")
                    await self._emit_tool_call(run, step, invocation, node_id, "search.query", params)
                    try:
                        result = await self._tool_invoke(run, "search.query", params)
                        evidence = research_search_evidence(claim, result)
                        summary = self._summarize_result("search.query", result)
                        status = "completed"
                        await self._emit_tool_success(run, step, invocation, node_id, "search.query", summary)
                    except Exception as error:
                        evidence = []
                        summary = str(error)
                        status = "partial"
                        await self._emit_tool_failure(run, step, invocation, node_id, "search.query", error)
                    updated_evidence = {
                        **(chain_state.get("auditResearchEvidence") or {}),
                        claim.claimId: [item.model_dump() for item in evidence],
                    }
                    updated = {
                        **chain_state,
                        "auditResearchIndex": search_index + 1,
                        "auditResearchEvidence": updated_evidence,
                        "toolCallCount": tool_call_count + 1,
                    }
                    await self._emit(
                        run,
                        "toolchain_node_completed",
                        step_id=step.stepId,
                        agent="research_rag",
                        status=status,
                        payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
                    )
                    return {"toolchain_state": updated, "action": "continue", "resume_response": None}

                if model_call_count >= definition.budget.maxModelCalls:
                    raise ToolchainError("BUDGET_EXCEEDED", "团队审计已用尽模型预算。", node_id="audit.research.synthesize")
                node_id = "audit.research.synthesize"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    raw = await self._automation_invoke(
                        run,
                        "agent.generate_research_fact_check",
                        research_fact_check_request(
                            plan.goal,
                            graph_state["locale"],
                            bundle,
                            research_claims,
                            research_evidence,
                        ),
                    )
                    review = normalize_research_fact_check(
                        raw,
                        bundle,
                        research_claims,
                        research_evidence,
                        list(chain_state.get("auditResearchWarnings") or []),
                    )
                except Exception as error:
                    failed_experts["research_rag"] = str(error)
                    updated = {
                        **chain_state,
                        "auditFailedExperts": failed_experts,
                        "modelCallCount": model_call_count + 1,
                    }
                    await self._emit(
                        run,
                        "toolchain_node_completed",
                        step_id=step.stepId,
                        agent="research_rag",
                        status="failed",
                        payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": str(error)},
                    )
                    return {"toolchain_state": updated, "action": "continue", "resume_response": None}
                root_findings = [
                    ExpertFinding(
                        findingId=finding.findingId,
                        title=finding.statement[:200],
                        summary=finding.summary,
                        category=finding.category,
                        severity=finding.severity,
                        chapterIds=finding.chapterIds,
                        expert="research_rag",
                        evidenceRefs=finding.evidenceRefs,
                        evidence=finding.evidence,
                        recommendation=finding.recommendation or None,
                        recommendedRole=finding.recommendedRole,
                        uncertainty=finding.uncertainty or None,
                    )
                    for finding in review.findings
                ]
                report, _, expert_ref = await self._publish_scope_audit_child(
                    run,
                    step,
                    invocation,
                    bundle,
                    expert="research_rag",
                    artifact_type="research_fact_check",
                    title="多章节考据与事实核查",
                    summary=review.summary,
                    content=research_fact_check_markdown(review),
                    findings=root_findings,
                    metadata_key="researchFactCheck",
                    metadata_value=review.model_dump(),
                )
                child_reports["research_rag"] = report.model_dump()
                expert_refs["research_rag"] = expert_ref.model_dump()
                completed_experts.add("research_rag")
                updated = {
                    **chain_state,
                    "auditCompletedExperts": sorted(completed_experts),
                    "auditChildReports": child_reports,
                    "auditExpertRefs": expert_refs,
                    "modelCallCount": model_call_count + 1,
                }
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            if not chain_state.get("reviewCompleted"):
                ordered_reports = [child_reports[expert] for expert in selected_experts if expert in child_reports]
                ordered_refs = [
                    ScopeAuditExpertRef.model_validate(expert_refs[expert])
                    for expert in selected_experts
                    if expert in expert_refs
                ]
                if not ordered_reports:
                    raise ToolchainError(
                        "CONTEXT_INSUFFICIENT",
                        "团队审计没有成功生成任何专家子报告。",
                        node_id="audit.synthesize",
                    )
                if model_call_count >= definition.budget.maxModelCalls:
                    raise ToolchainError("BUDGET_EXCEEDED", "团队审计已用尽模型预算。", node_id="audit.synthesize")
                node_id = "audit.synthesize"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    raw_audit = await self._automation_invoke(
                        run,
                        "agent.generate_scope_audit",
                        scope_audit_request(plan.goal, graph_state["locale"], ordered_reports),
                    )
                    audit = normalize_scope_audit(raw_audit, bundle, ordered_reports, ordered_refs)
                except Exception as error:
                    raise ToolchainError(
                        "NODE_FAILED",
                        f"Scope audit synthesis failed: {error}",
                        node_id=node_id,
                        retryable=True,
                    ) from error
                artifact_id = new_id("artifact")
                report = ExpertReportPayload(
                    artifactId=artifact_id,
                    novelId=bundle.scope.novelId,
                    runId=run.runId,
                    planId=run.planId,
                    type="scope_audit",
                    title="团队多章节综合审计",
                    expert="supervisor",
                    scope=bundle.scope,
                    findings=[
                        ExpertFinding(
                            findingId=finding.findingId,
                            title=finding.title,
                            summary=finding.summary,
                            category=finding.category,
                            severity=finding.severity,
                            chapterIds=finding.chapterIds,
                            expert="supervisor",
                            evidenceRefs=finding.evidenceRefs,
                            evidence=finding.evidence,
                            recommendation=finding.recommendation or None,
                            recommendedRole=finding.recommendedRole,
                            uncertainty=finding.uncertainty or None,
                        )
                        for finding in audit.findings
                    ],
                    sourceSnapshot=bundle.sourceSnapshot or bundle.scope.snapshot,
                    coverage=bundle.coverage,
                    summary=audit.summary,
                    generatedAt=utc_now(),
                )
                artifact = await self._publish_artifact(
                    run,
                    artifact_id=artifact_id,
                    artifact_type="scope_audit",
                    title=report.title,
                    summary=audit.summary[:500],
                    content=scope_audit_markdown(audit),
                    reference={
                        "novelId": bundle.scope.novelId,
                        "volumeId": bundle.scope.volumeId,
                        "chapterId": bundle.scope.anchorChapterId,
                        "scopeId": bundle.scope.scopeId,
                        "scopeKind": bundle.scope.kind,
                        "toolchainId": invocation.id,
                        "version": invocation.version,
                    },
                    metadata={
                        "expertReport": report.model_dump(),
                        "scopeAudit": audit.model_dump(),
                        "childArtifactIds": [item.artifactId for item in ordered_refs],
                        "executedExperts": [item.expert for item in ordered_refs],
                        "failedExperts": failed_experts,
                        "maxConcurrency": input_data.maxConcurrency,
                        "contextStats": {
                            "toolCallCount": int(chain_state.get("toolCallCount") or 0),
                            "modelCallCount": model_call_count + 1,
                            "estimatedTokens": bundle.estimatedTokens,
                            "coverage": bundle.coverage.model_dump(),
                        },
                    },
                    step_id=step.stepId,
                    agent="supervisor",
                )
                updated = {
                    **chain_state,
                    "reviewCompleted": True,
                    "artifactId": artifact.artifactId,
                    "modelCallCount": model_call_count + 1,
                    "output": report.model_dump(),
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent="supervisor",
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": audit.summary[:240],
                        "artifactId": artifact.artifactId,
                        "executedExperts": [item.expert for item in ordered_refs],
                        "failedExperts": failed_experts,
                        "findingCount": len(audit.findings),
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            return await self._complete_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
                chain_state.get("output") or {},
                artifact_id=artifact_id,
                tool_call_count=int(chain_state.get("toolCallCount") or 0),
            )
        if invocation.id == "research.range_fact_check":
            input_data = ResearchRangeFactCheckInput.model_validate(chain_state.get("toolchainInput") or {})
            claims = [
                ResearchExtractedClaim.model_validate(item)
                for item in (chain_state.get("researchClaims") or [])
            ]
            search_evidence = {
                claim_id: [ContextEvidence.model_validate(item) for item in items]
                for claim_id, items in (chain_state.get("researchSearchEvidence") or {}).items()
            }
            model_call_count = int(chain_state.get("modelCallCount") or 0)
            if not chain_state.get("claimsExtracted"):
                if model_call_count >= definition.budget.maxModelCalls:
                    raise ToolchainError(
                        "BUDGET_EXCEEDED",
                        f"考据链已用尽模型预算：{model_call_count}/{definition.budget.maxModelCalls}。",
                        node_id="research.extract_claims",
                    )
                node_id = "research.extract_claims"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    raw_extraction = await self._automation_invoke(
                        run,
                        "agent.extract_research_claims",
                        research_claim_extraction_request(
                            plan.goal,
                            graph_state["locale"],
                            bundle,
                            input_data.maxClaims,
                        ),
                    )
                    extraction = normalize_research_claims(raw_extraction, bundle, input_data.maxClaims)
                except Exception as error:
                    raise ToolchainError(
                        "NODE_FAILED",
                        f"Research claim extraction failed: {error}",
                        node_id=node_id,
                        retryable=True,
                    ) from error
                search_queue = [
                    claim.claimId
                    for claim in extraction.claims
                    if claim.needsProjectSearch and claim.searchKeyword
                ][:input_data.maxProjectSearches]
                updated = {
                    **chain_state,
                    "claimsExtracted": True,
                    "researchClaims": [item.model_dump() for item in extraction.claims],
                    "researchExtractionWarnings": extraction.warnings,
                    "researchSearchQueue": search_queue,
                    "researchSearchIndex": 0,
                    "researchSearchEvidence": {},
                    "modelCallCount": model_call_count + 1,
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": f"已提取 {len(extraction.claims)} 条可核验声明。",
                        "claimCount": len(extraction.claims),
                        "searchCount": len(search_queue),
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            search_queue = [str(item) for item in (chain_state.get("researchSearchQueue") or [])]
            search_index = int(chain_state.get("researchSearchIndex") or 0)
            if search_index < len(search_queue):
                claim_id = search_queue[search_index]
                claim = next((item for item in claims if item.claimId == claim_id), None)
                if claim is None:
                    updated = {**chain_state, "researchSearchIndex": search_index + 1}
                    return {"toolchain_state": updated, "action": "continue", "resume_response": None}
                tool_call_count = int(chain_state.get("toolCallCount") or 0)
                node_id = f"research.project_search.{search_index + 1}"
                if tool_call_count >= definition.budget.maxToolCalls:
                    raise ToolchainError(
                        "BUDGET_EXCEEDED",
                        f"考据链已用尽工具预算：{tool_call_count}/{definition.budget.maxToolCalls}。",
                        node_id=node_id,
                    )
                tool_name = "search.query"
                params = research_search_params(bundle.scope.novelId, claim)
                self._require_toolchain_tool(definition, tool_name, node_id)
                await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
                await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
                warnings = list(chain_state.get("warnings") or [])
                try:
                    result = await self._tool_invoke(run, tool_name, params)
                    evidence = research_search_evidence(claim, result)
                    summary = self._summarize_result(tool_name, result)
                    status = "completed"
                    await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
                except Exception as error:
                    evidence = []
                    summary = str(error)
                    status = "partial"
                    warnings.append(f"声明 {claim.claimId} 的项目全文检索失败：{error}")
                    await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                updated_evidence = {
                    **(chain_state.get("researchSearchEvidence") or {}),
                    claim.claimId: [item.model_dump() for item in evidence],
                }
                updated = {
                    **chain_state,
                    "researchSearchIndex": search_index + 1,
                    "researchSearchEvidence": updated_evidence,
                    "toolCallCount": tool_call_count + 1,
                    "warnings": warnings,
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=tool_name,
                    status=status,
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": summary,
                        "claimId": claim.claimId,
                        "evidenceCount": len(evidence),
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            if not chain_state.get("reviewCompleted"):
                if model_call_count >= definition.budget.maxModelCalls:
                    raise ToolchainError(
                        "BUDGET_EXCEEDED",
                        f"考据链已用尽模型预算：{model_call_count}/{definition.budget.maxModelCalls}。",
                        node_id="research.synthesize",
                    )
                node_id = "research.synthesize"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    raw_report = await self._automation_invoke(
                        run,
                        "agent.generate_research_fact_check",
                        research_fact_check_request(
                            plan.goal,
                            graph_state["locale"],
                            bundle,
                            claims,
                            search_evidence,
                        ),
                    )
                    review = normalize_research_fact_check(
                        raw_report,
                        bundle,
                        claims,
                        search_evidence,
                        [
                            *(chain_state.get("researchExtractionWarnings") or []),
                            *(chain_state.get("warnings") or []),
                        ],
                    )
                except Exception as error:
                    raise ToolchainError(
                        "NODE_FAILED",
                        f"Research fact-check synthesis failed: {error}",
                        node_id=node_id,
                        retryable=True,
                    ) from error
                artifact_id = new_id("artifact")
                report = ExpertReportPayload(
                    artifactId=artifact_id,
                    novelId=bundle.scope.novelId,
                    runId=run.runId,
                    planId=run.planId,
                    type="research_fact_check",
                    title="多章节考据与事实核查",
                    expert="research_rag",
                    scope=bundle.scope,
                    findings=[
                        ExpertFinding(
                            findingId=finding.findingId,
                            title=finding.statement[:200],
                            summary=finding.summary,
                            category=finding.category,
                            severity=finding.severity,
                            chapterIds=finding.chapterIds,
                            expert="research_rag",
                            evidenceRefs=finding.evidenceRefs,
                            evidence=finding.evidence,
                            recommendation=finding.recommendation or None,
                            recommendedRole=finding.recommendedRole,
                            uncertainty=finding.uncertainty or None,
                        )
                        for finding in review.findings
                    ],
                    sourceSnapshot=bundle.sourceSnapshot or bundle.scope.snapshot,
                    coverage=bundle.coverage,
                    summary=review.summary,
                    generatedAt=utc_now(),
                )
                artifact = await self._publish_artifact(
                    run,
                    artifact_id=artifact_id,
                    artifact_type="research_fact_check",
                    title=report.title,
                    summary=review.summary[:500],
                    content=research_fact_check_markdown(review),
                    reference={
                        "novelId": bundle.scope.novelId,
                        "volumeId": bundle.scope.volumeId,
                        "chapterId": bundle.scope.anchorChapterId,
                        "scopeId": bundle.scope.scopeId,
                        "scopeKind": bundle.scope.kind,
                        "toolchainId": invocation.id,
                        "version": invocation.version,
                    },
                    metadata={
                        "expertReport": report.model_dump(),
                        "researchFactCheck": review.model_dump(),
                        "contextStats": {
                            "toolCallCount": int(chain_state.get("toolCallCount") or 0),
                            "modelCallCount": model_call_count + 1,
                            "estimatedTokens": bundle.estimatedTokens,
                            "coverage": bundle.coverage.model_dump(),
                        },
                    },
                    step_id=step.stepId,
                    agent=step.agent,
                )
                updated = {
                    **chain_state,
                    "reviewCompleted": True,
                    "artifactId": artifact.artifactId,
                    "modelCallCount": model_call_count + 1,
                    "output": report.model_dump(),
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": review.summary[:240],
                        "artifactId": artifact.artifactId,
                        "claimCount": len(review.claims),
                        "findingCount": len(review.findings),
                        "searchStats": review.searchStats,
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            return await self._complete_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
                chain_state.get("output") or {},
                artifact_id=artifact_id,
                tool_call_count=int(chain_state.get("toolCallCount") or 0),
            )
        if invocation.id == "worldbuilding.range_consistency":
            if not chain_state.get("reviewCompleted"):
                node_id = "worldbuilding.synthesize"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    input_data = WorldbuildingRangeConsistencyInput.model_validate(
                        chain_state.get("toolchainInput") or {}
                    )
                    raw_review = await self._automation_invoke(
                        run,
                        "agent.generate_worldbuilding_range_consistency",
                        worldbuilding_consistency_request(
                            plan.goal,
                            graph_state["locale"],
                            bundle,
                            input_data.dimensions,
                        ),
                    )
                    review = normalize_worldbuilding_consistency(raw_review, bundle)
                except Exception as error:
                    raise ToolchainError(
                        "NODE_FAILED",
                        f"Worldbuilding range consistency synthesis failed: {error}",
                        node_id=node_id,
                        retryable=True,
                    ) from error
                artifact_id = new_id("artifact")
                report = ExpertReportPayload(
                    artifactId=artifact_id,
                    novelId=bundle.scope.novelId,
                    runId=run.runId,
                    planId=run.planId,
                    type="worldbuilding_consistency",
                    title="世界观多章节一致性审核",
                    expert="worldbuilding",
                    scope=bundle.scope,
                    findings=[
                        ExpertFinding(
                            findingId=finding.findingId,
                            title=finding.title,
                            summary=finding.summary,
                            category=finding.category,
                            severity=finding.severity,
                            chapterIds=finding.chapterIds,
                            expert="worldbuilding",
                            evidenceRefs=finding.evidenceRefs,
                            evidence=finding.evidence,
                            recommendation=finding.recommendation or None,
                            recommendedRole=finding.recommendedRole,
                            uncertainty=finding.uncertainty or None,
                        )
                        for finding in review.findings
                    ],
                    sourceSnapshot=bundle.sourceSnapshot or bundle.scope.snapshot,
                    coverage=bundle.coverage,
                    summary=review.summary,
                    generatedAt=utc_now(),
                )
                artifact = await self._publish_artifact(
                    run,
                    artifact_id=artifact_id,
                    artifact_type="worldbuilding_consistency",
                    title=report.title,
                    summary=review.summary[:500],
                    content=worldbuilding_consistency_markdown(review),
                    reference={
                        "novelId": bundle.scope.novelId,
                        "volumeId": bundle.scope.volumeId,
                        "chapterId": bundle.scope.anchorChapterId,
                        "scopeId": bundle.scope.scopeId,
                        "scopeKind": bundle.scope.kind,
                        "toolchainId": invocation.id,
                        "version": invocation.version,
                    },
                    metadata={
                        "expertReport": report.model_dump(),
                        "worldbuildingConsistency": review.model_dump(),
                        "contextStats": {
                            "toolCallCount": int(chain_state.get("toolCallCount") or 0),
                            "estimatedTokens": bundle.estimatedTokens,
                            "coverage": bundle.coverage.model_dump(),
                        },
                    },
                    step_id=step.stepId,
                    agent=step.agent,
                )
                updated = {
                    **chain_state,
                    "reviewCompleted": True,
                    "artifactId": artifact.artifactId,
                    "output": report.model_dump(),
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": review.summary[:240],
                        "artifactId": artifact.artifactId,
                        "findingCount": len(review.findings),
                        "entityCount": len(review.entityAssessments),
                        "coverage": bundle.coverage.model_dump(),
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            return await self._complete_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
                chain_state.get("output") or {},
                artifact_id=artifact_id,
                tool_call_count=int(chain_state.get("toolCallCount") or 0),
            )
        if invocation.id == "writer.range_revision_plan":
            if not chain_state.get("reviewCompleted"):
                node_id = "revision_plan.synthesize"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    input_data = WriterRangeRevisionPlanInput.model_validate(chain_state.get("toolchainInput") or {})
                    raw_plan = await self._automation_invoke(
                        run,
                        "agent.generate_writer_range_revision_plan",
                        writer_range_revision_plan_request(
                            plan.goal,
                            graph_state["locale"],
                            bundle,
                            input_data.dimensions,
                        ),
                    )
                    revision_plan = normalize_writer_range_revision_plan(raw_plan, bundle)
                except Exception as error:
                    raise ToolchainError(
                        "NODE_FAILED",
                        f"Writer range revision planning failed: {error}",
                        node_id=node_id,
                        retryable=True,
                    ) from error
                artifact_id = new_id("artifact")
                report = ExpertReportPayload(
                    artifactId=artifact_id,
                    novelId=bundle.scope.novelId,
                    runId=run.runId,
                    planId=run.planId,
                    type="writer_revision_plan",
                    title="作者多章节修订计划",
                    expert="writer",
                    scope=bundle.scope,
                    findings=[
                        ExpertFinding(
                            findingId=finding.findingId,
                            title=finding.title,
                            summary=finding.summary,
                            category=finding.category,
                            severity=finding.severity,
                            chapterIds=finding.chapterIds,
                            expert="writer",
                            evidenceRefs=finding.evidenceRefs,
                            evidence=finding.evidence,
                            recommendation=finding.recommendation or None,
                            recommendedRole=finding.recommendedRole,
                            uncertainty=finding.uncertainty or None,
                        )
                        for finding in revision_plan.findings
                    ],
                    sourceSnapshot=bundle.sourceSnapshot or bundle.scope.snapshot,
                    coverage=bundle.coverage,
                    summary=revision_plan.summary,
                    generatedAt=utc_now(),
                )
                artifact = await self._publish_artifact(
                    run,
                    artifact_id=artifact_id,
                    artifact_type="writer_revision_plan",
                    title=report.title,
                    summary=revision_plan.summary[:500],
                    content=writer_range_revision_plan_markdown(revision_plan),
                    reference={
                        "novelId": bundle.scope.novelId,
                        "volumeId": bundle.scope.volumeId,
                        "chapterId": bundle.scope.anchorChapterId,
                        "scopeId": bundle.scope.scopeId,
                        "scopeKind": bundle.scope.kind,
                        "toolchainId": invocation.id,
                        "version": invocation.version,
                    },
                    metadata={
                        "expertReport": report.model_dump(),
                        "writerRevisionPlan": revision_plan.model_dump(),
                        "contextStats": {
                            "toolCallCount": int(chain_state.get("toolCallCount") or 0),
                            "estimatedTokens": bundle.estimatedTokens,
                            "coverage": bundle.coverage.model_dump(),
                        },
                    },
                    step_id=step.stepId,
                    agent=step.agent,
                )
                updated = {
                    **chain_state,
                    "reviewCompleted": True,
                    "artifactId": artifact.artifactId,
                    "output": report.model_dump(),
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": revision_plan.summary[:240],
                        "artifactId": artifact.artifactId,
                        "findingCount": len(revision_plan.findings),
                        "rewriteCount": len(revision_plan.rewriteOrder),
                        "coverage": bundle.coverage.model_dump(),
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            return await self._complete_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
                chain_state.get("output") or {},
                artifact_id=artifact_id,
                tool_call_count=int(chain_state.get("toolCallCount") or 0),
            )
        if invocation.id == "editor.range_review":
            if not chain_state.get("reviewCompleted"):
                node_id = "review.synthesize"
                await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
                try:
                    input_data = EditorRangeReviewInput.model_validate(chain_state.get("toolchainInput") or {})
                    raw_review = await self._automation_invoke(
                        run,
                        "agent.generate_editor_range_review",
                        editor_range_review_request(
                            plan.goal,
                            graph_state["locale"],
                            bundle,
                            input_data.dimensions,
                        ),
                    )
                    review = normalize_editor_range_review(raw_review, bundle)
                except Exception as error:
                    raise ToolchainError(
                        "NODE_FAILED",
                        f"Editor range review synthesis failed: {error}",
                        node_id=node_id,
                        retryable=True,
                    ) from error
                artifact_id = new_id("artifact")
                report = ExpertReportPayload(
                    artifactId=artifact_id,
                    novelId=bundle.scope.novelId,
                    runId=run.runId,
                    planId=run.planId,
                    type="chapter_range_review",
                    title="编辑多章节范围审核",
                    expert="editor",
                    scope=bundle.scope,
                    findings=[
                        ExpertFinding(
                            findingId=finding.findingId,
                            title=finding.title,
                            summary=finding.summary,
                            category=finding.category,
                            severity=finding.severity,
                            chapterIds=finding.chapterIds,
                            expert="editor",
                            evidenceRefs=finding.evidenceRefs,
                            evidence=finding.evidence,
                            recommendation=finding.recommendation or None,
                            recommendedRole=finding.recommendedRole,
                            uncertainty=finding.uncertainty or None,
                        )
                        for finding in review.findings
                    ],
                    sourceSnapshot=bundle.sourceSnapshot or bundle.scope.snapshot,
                    coverage=bundle.coverage,
                    summary=review.summary,
                    generatedAt=utc_now(),
                )
                artifact = await self._publish_artifact(
                    run,
                    artifact_id=artifact_id,
                    artifact_type="chapter_range_review",
                    title=report.title,
                    summary=review.summary[:500],
                    content=editor_range_review_markdown(review),
                    reference={
                        "novelId": bundle.scope.novelId,
                        "volumeId": bundle.scope.volumeId,
                        "chapterId": bundle.scope.anchorChapterId,
                        "scopeId": bundle.scope.scopeId,
                        "scopeKind": bundle.scope.kind,
                        "toolchainId": invocation.id,
                        "version": invocation.version,
                    },
                    metadata={
                        "expertReport": report.model_dump(),
                        "editorReview": review.model_dump(),
                        "contextStats": {
                            "toolCallCount": int(chain_state.get("toolCallCount") or 0),
                            "estimatedTokens": bundle.estimatedTokens,
                            "coverage": bundle.coverage.model_dump(),
                        },
                    },
                    step_id=step.stepId,
                    agent=step.agent,
                )
                updated = {
                    **chain_state,
                    "reviewCompleted": True,
                    "artifactId": artifact.artifactId,
                    "output": report.model_dump(),
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": review.summary[:240],
                        "artifactId": artifact.artifactId,
                        "findingCount": len(review.findings),
                        "coverage": bundle.coverage.model_dump(),
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            return await self._complete_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
                chain_state.get("output") or {},
                artifact_id=artifact_id,
                tool_call_count=int(chain_state.get("toolCallCount") or 0),
            )
        if not artifact_id:
            coverage = bundle.coverage
            artifact = await self._publish_artifact(
                run,
                artifact_type="chapter_scope_context",
                title="多章节范围上下文",
                summary=(
                    f"范围 {coverage.totalChapterCount} 章，详细 {coverage.detailedChapterCount} 章，"
                    f"摘要 {coverage.summarizedChapterCount} 章，分 {coverage.batchCount} 批。"
                ),
                content=json.dumps(bundle.model_dump(), ensure_ascii=False, indent=2),
                reference={
                    "novelId": bundle.scope.novelId,
                    "volumeId": bundle.scope.volumeId,
                    "chapterId": bundle.scope.anchorChapterId,
                    "scopeId": bundle.scope.scopeId,
                    "scopeKind": bundle.scope.kind,
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                },
                metadata={
                    "contextBundle": bundle.model_dump(),
                    "roleProjection": role,
                    "sourceStatus": chain_state.get("sourceStatus") or {},
                },
                step_id=step.stepId,
                agent=step.agent,
            )
            artifact_id = artifact.artifactId
            updated = {**chain_state, "artifactId": artifact_id, "output": bundle.model_dump()}
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": "scope.publish",
                    "summary": artifact.summary,
                    "artifactId": artifact_id,
                    "coverage": coverage.model_dump(),
                },
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        return await self._complete_toolchain(
            run,
            plan,
            step,
            graph_state,
            chain_state,
            definition,
            chain_state.get("output") or bundle.model_dump(),
            artifact_id=artifact_id,
            tool_call_count=int(chain_state.get("toolCallCount") or 0),
        )

    async def _advance_plotline_analysis_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
        chain_state: dict[str, Any],
        definition: Any,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Plotline analysis has no Toolchain invocation")
        input_data = PlotlineAnalysisInput.model_validate(chain_state.get("toolchainInput") or {})
        input_budget = input_data.maxEstimatedTokens
        max_tokens = (
            min(definition.budget.maxEstimatedTokens, input_budget)
            if input_budget
            else definition.budget.maxEstimatedTokens
        )

        if not chain_state.get("scopeChecked"):
            selected_scope = next(
                (
                    PLOTLINE_SCOPE_OPTIONS[option_id]
                    for response in reversed(run.approvalResponses)
                    if response.get("checkpointType") == "analysis_scope"
                    for option_id in (response.get("selectedOptionIds") or [])
                    if option_id in PLOTLINE_SCOPE_OPTIONS
                ),
                None,
            )
            scope = selected_scope or infer_plotline_scope(input_data.goal)
            if scope is None:
                checkpoint = self._plotline_scope_checkpoint(step.stepId, input_data)
                await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                return {
                    "toolchain_state": chain_state,
                    "checkpoint": checkpoint,
                    "action": "waiting_approval",
                    "resume_response": None,
                }
            node_id = "scope.resolve"
            await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="transform")
            updated = resolve_plotline_scope(chain_state, scope)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": f"分析范围已确定为 {scope}。",
                    "scope": scope,
                },
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if chain_state.get("plotlines") is None:
            node_id = "plotline.read"
            tool_name = "plotline.list"
            params = {"novelId": input_data.novelId}
            self._require_toolchain_tool(definition, tool_name, node_id)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                result = await self._tool_invoke(run, tool_name, params)
                updated = apply_plotline_result(chain_state, result)
                summary = self._summarize_result(tool_name, result)
                status = "completed"
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                updated = {
                    **chain_state,
                    "plotlines": [],
                    "warnings": [
                        *(chain_state.get("warnings") or []),
                        f"情节线资料读取失败，报告将只基于章节正文：{error}",
                    ],
                    "sourceStatus": {**(chain_state.get("sourceStatus") or {}), node_id: "failed"},
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
                }
                summary = str(error)
                status = "partial"
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status=status,
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        scope = str(chain_state.get("scope") or "")
        if scope != "chapter" and chain_state.get("volumes") is None:
            node_id = "volume.read"
            tool_name = "volume.list"
            params = {"novelId": input_data.novelId}
            self._require_toolchain_tool(definition, tool_name, node_id)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                result = await self._tool_invoke(run, tool_name, params)
                updated = apply_volume_result(chain_state, result)
                summary = self._summarize_result(tool_name, result)
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "CONTEXT_INSUFFICIENT",
                    f"无法读取卷与章节结构：{error}",
                    node_id=node_id,
                    retryable=True,
                ) from error
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("batchesPlanned"):
            node_id = "batch.plan"
            await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="transform")
            updated = build_plotline_batches(chain_state)
            coverage = updated.get("coverage") or {}
            summary = (
                f"已规划 {coverage.get('batchCount', 0)} 批，"
                f"覆盖 {coverage.get('selectedChapterCount', 0)} 章，"
                f"省略 {coverage.get('omittedChapterCount', 0)} 章。"
            )
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": summary,
                    "coverage": coverage,
                },
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        batch_index = int(chain_state.get("batchIndex") or 0)
        batches = list(chain_state.get("batches") or [])
        if batch_index < len(batches):
            call_count = int(chain_state.get("toolCallCount") or 0)
            estimated_tokens = int(chain_state.get("estimatedTokens") or 0)
            if call_count >= definition.budget.maxToolCalls - 1 or estimated_tokens >= max_tokens:
                reason = (
                    "情节线分析预算已达到上限，已停止读取剩余章节："
                    f"calls {call_count}/{definition.budget.maxToolCalls}, "
                    f"tokens {estimated_tokens}/{max_tokens}。"
                )
                updated = skip_remaining_batches(chain_state, reason)
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="skipped",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": f"chapter.batch.{batch_index + 1}",
                        "summary": reason,
                        "code": "BUDGET_EXCEEDED",
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}

            tool_name, params, node_id = build_chapter_batch_call(chain_state)
            self._require_toolchain_tool(definition, tool_name, node_id)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                result = await self._tool_invoke(run, tool_name, params)
                updated = apply_chapter_batch_result(
                    chain_state,
                    result,
                    max_estimated_tokens=max_tokens,
                )
                summary = self._summarize_result(tool_name, result)
                status = "completed"
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                updated = apply_chapter_batch_failure(chain_state, error)
                summary = str(error)
                status = "partial"
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status=status,
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("ragCompleted"):
            node_id = "rag.retrieve"
            call_count = int(chain_state.get("toolCallCount") or 0)
            estimated_tokens = int(chain_state.get("estimatedTokens") or 0)
            if call_count >= definition.budget.maxToolCalls or estimated_tokens >= max_tokens:
                reason = (
                    "已达到情节线分析预算，跳过额外 RAG 检索；"
                    "报告会明确标注仅基于已读取章节。"
                )
                updated = {
                    **chain_state,
                    "ragCompleted": True,
                    "warnings": [*(chain_state.get("warnings") or []), reason],
                    "sourceStatus": {**(chain_state.get("sourceStatus") or {}), node_id: "skipped"},
                }
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="skipped",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "summary": reason,
                        "code": "BUDGET_EXCEEDED",
                    },
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            tool_name = "rag.ask"
            params = plotline_rag_params(input_data, chain_state)
            self._require_toolchain_tool(definition, tool_name, node_id)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                result = await self._tool_invoke(run, tool_name, params)
                updated = apply_rag_result(chain_state, result)
                summary = self._summarize_result(tool_name, result)
                status = "completed"
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                updated = apply_rag_failure(chain_state, error)
                summary = str(error)
                status = "partial"
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status=status,
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        context = build_plotline_context(chain_state)
        if not chain_state.get("analysis"):
            node_id = "analysis.synthesize"
            if int(chain_state.get("modelCallCount") or 0) >= definition.budget.maxModelCalls:
                raise ToolchainError(
                    "BUDGET_EXCEEDED",
                    "情节线分析已用尽模型综合预算。",
                    node_id=node_id,
                )
            await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="model")
            try:
                raw_analysis = await self._automation_invoke(
                    run,
                    "agent.generate_plotline_analysis",
                    plotline_analysis_request(input_data, context),
                )
                analysis = normalize_plotline_analysis(raw_analysis, context)
            except Exception as error:
                raise ToolchainError(
                    "NODE_FAILED",
                    f"情节线综合分析失败：{error}",
                    node_id=node_id,
                    retryable=True,
                ) from error
            artifact = await self._publish_artifact(
                run,
                artifact_type="plotline_analysis",
                title="情节线分析",
                summary=analysis.summary[:500],
                content=plotline_analysis_markdown(analysis),
                reference={
                    "novelId": input_data.novelId,
                    "volumeId": input_data.volumeId,
                    "chapterId": input_data.chapterId,
                    "scope": analysis.scope,
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                },
                metadata={"analysis": analysis.model_dump(), "context": context.model_dump()},
                step_id=step.stepId,
                agent=step.agent,
            )
            updated = {
                **chain_state,
                "analysis": analysis.model_dump(),
                "artifactId": artifact.artifactId,
                "modelCallCount": int(chain_state.get("modelCallCount") or 0) + 1,
                "sourceStatus": {**(chain_state.get("sourceStatus") or {}), node_id: "completed"},
            }
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": analysis.summary[:240],
                    "artifactId": artifact.artifactId,
                    "coverage": analysis.coverage,
                },
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        return await self._complete_toolchain(
            run,
            plan,
            step,
            graph_state,
            chain_state,
            definition,
            chain_state.get("analysis") or {},
            artifact_id=str(chain_state.get("artifactId") or "") or None,
            tool_call_count=int(chain_state.get("toolCallCount") or 0),
        )

    async def _advance_chapter_continuation_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
        chain_state: dict[str, Any],
        definition: Any,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Chapter continuation has no Toolchain invocation")
        input_data = ChapterContinuationInput.model_validate(chain_state.get("toolchainInput") or {})

        if not chain_state.get("continuationContext"):
            node_id = "context.build"
            tool_name = "chapter.continuation_context.build"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = continuation_context_params(input_data)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                continuation_context = await self._tool_invoke(run, tool_name, params)
                build_continuation_context_bundle(continuation_context)
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id, retryable=True) from error
            summary = self._summarize_result(tool_name, continuation_context)
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            updated = {
                **chain_state,
                "continuationContext": continuation_context,
                "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
            }
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("continuationEvidence"):
            node_id = "rag.retrieve"
            tool_name = "rag.ask"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = {
                "novelId": input_data.novelId,
                "chapterId": input_data.chapterId,
                "question": input_data.goal,
                "locale": input_data.locale,
                "maxEvidenceItems": 8,
            }
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                evidence = await self._tool_invoke(run, tool_name, params)
                summary = self._summarize_result(tool_name, evidence)
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
                status = "completed"
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                evidence = {"evidence": [], "warnings": [f"RAG evidence unavailable: {error}"]}
                summary = str(error)
                status = "partial"
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status=status,
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            updated = {
                **chain_state,
                "continuationEvidence": evidence,
                "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
            }
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        context_bundle = build_continuation_context_bundle(
            chain_state.get("continuationContext"),
            chain_state.get("continuationEvidence"),
        )

        if not chain_state.get("evidenceChecked"):
            evidence_result = {
                "confidence": "high" if context_bundle.evidence else "low",
                "warnings": context_bundle.warnings,
                "evidence": [item.model_dump() for item in context_bundle.evidence],
            }
            checkpoint = self._evidence_quality_checkpoint(step.stepId, evidence_result)
            updated = {**chain_state, "evidenceChecked": True}
            if checkpoint:
                await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                return {
                    "toolchain_state": updated,
                    "checkpoint": checkpoint,
                    "action": "waiting_approval",
                    "resume_response": None,
                }
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if self._has_approval_choice(run, "evidence_quality", "report_only"):
            return await self._complete_draft_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
                {"skipped": True, "reason": "report_only", "context": context_bundle.model_dump()},
                artifact_id=None,
            )

        if not chain_state.get("creativeDirectionChecked"):
            if int(chain_state.get("modelCallCount") or 0) >= definition.budget.maxModelCalls:
                raise ToolchainError(
                    "BUDGET_EXCEEDED",
                    "Chapter continuation exhausted its model decision budget.",
                    node_id="direction.check",
                )
            try:
                checkpoint = await self._creative_direction_checkpoint(
                    run,
                    step.stepId,
                    plan.goal,
                    plan.title,
                    step.title,
                    self._context_summary(context_bundle),
                    graph_state["locale"],
                )
            except Exception as error:
                raise ToolchainError(
                    "NODE_FAILED",
                    f"Creative direction check failed: {error}",
                    node_id="direction.check",
                    retryable=True,
                ) from error
            updated = {
                **chain_state,
                "creativeDirectionChecked": True,
                "modelCallCount": int(chain_state.get("modelCallCount") or 0) + 1,
            }
            if checkpoint:
                await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                return {
                    "toolchain_state": updated,
                    "checkpoint": checkpoint,
                    "action": "waiting_approval",
                    "resume_response": None,
                }
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("brief"):
            node_id = "brief.assemble"
            await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="transform")
            brief = build_generation_brief(
                input_data,
                context_bundle,
                self._latest_approval_summary(run, "creative_direction"),
            )
            updated = {**chain_state, "brief": brief}
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": brief[:240]},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("draftResult"):
            node_id = "draft.generate"
            tool_name = "chapter.generate_draft"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = chapter_draft_params(
                input_data,
                context_bundle,
                str(chain_state["brief"]),
                chain_state.get("continuationContext"),
            )
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                raw_draft = await self._tool_invoke(run, tool_name, params)
                session = normalize_chapter_draft(raw_draft)
            except SideEffectResultUnknown as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "SIDE_EFFECT_UNKNOWN",
                    str(error),
                    node_id=node_id,
                    details={"invocationKey": error.invocation_key, "method": error.method},
                ) from error
            except ToolchainError:
                raise
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id) from error

            run.draftSessionId = session.draftSessionId
            summary = session.previewSummary or "章节续写草稿已生成，等待审核。"
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "draft_created",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "draftSessionId": session.draftSessionId,
                    "draftType": session.type,
                    "previewSummary": session.previewSummary,
                    "toolchainId": invocation.id,
                },
            )
            artifact = await self._publish_artifact(
                run,
                artifact_type="chapter_draft",
                title="章节续写草稿",
                summary=summary,
                reference={"draftSessionId": session.draftSessionId},
                metadata={
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                    "draftSession": session.model_dump(),
                    "contextBundle": context_bundle.model_dump(),
                },
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
            )
            result = DraftToolchainResult(
                draftSessionId=session.draftSessionId,
                draftType=session.type,
                status=session.status,
                version=session.version,
                previewSummary=session.previewSummary,
                artifactId=artifact.artifactId,
                warnings=context_bundle.warnings,
                contextStats={
                    "toolCallCount": context_bundle.toolCallCount + 1,
                    "estimatedTokens": context_bundle.estimatedTokens,
                    "evidenceCount": len(context_bundle.evidence),
                },
            )
            updated = {**chain_state, "draftResult": result.model_dump(), "artifactId": artifact.artifactId}
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": summary,
                    "artifactId": artifact.artifactId,
                },
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        return await self._complete_draft_toolchain(
            run,
            plan,
            step,
            graph_state,
            chain_state,
            definition,
            chain_state["draftResult"],
            artifact_id=str(chain_state.get("artifactId") or "") or None,
        )

    async def _record_sequence_child_failure(
        self,
        run: AgentRun,
        step: Any,
        invocation: Any,
        definition: Any,
        batch: Any,
        child_index: int,
        *,
        code: str,
        message: str,
        side_effect_unknown: bool,
        invocation_key: str | None = None,
        request_id: str | None = None,
        method: str | None = None,
    ) -> None:
        node_id = f"draft.fail.{child_index}"
        tool_name = "draft.batch.mark_failed"
        params = {
            "draftBatchId": batch.draftBatchId,
            "version": batch.version,
            "childIndex": child_index,
            "generationRevision": batch.children[child_index].generationRevision,
            "error": {
                "code": code,
                "message": message,
                "sideEffectUnknown": side_effect_unknown,
                **({"invocationKey": invocation_key} if invocation_key else {}),
                **({"requestId": request_id} if request_id else {}),
                **({"method": method} if method else {}),
            },
        }
        try:
            self._require_toolchain_tool(definition, tool_name, node_id)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            failed_batch = normalize_draft_batch(await self._tool_invoke(run, tool_name, params), node_id)
            summary = f"第 {child_index + 1} 章生成失败已记录，可从该章继续。"
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": summary,
                    "draftBatchId": failed_batch.draftBatchId,
                    "childIndex": child_index,
                    "sideEffectUnknown": side_effect_unknown,
                },
            )
        except Exception as record_error:
            await self._emit(
                run,
                "error",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="failed",
                payload={
                    "message": f"Failed to persist batch child failure: {record_error}",
                    "stage": node_id,
                    "originalCode": code,
                },
            )

    async def _advance_chapter_sequence_continuation_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
        chain_state: dict[str, Any],
        definition: Any,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Chapter sequence continuation has no Toolchain invocation")
        is_rewrite = invocation.id == "chapter.batch_rewrite"
        input_data = (
            ChapterBatchRewriteInput.model_validate(chain_state.get("toolchainInput") or {})
            if is_rewrite
            else ChapterSequenceContinuationInput.model_validate(chain_state.get("toolchainInput") or {})
        )

        if not chain_state.get("continuationContext"):
            node_id = "context.build"
            tool_name = "chapter.scope_context.build" if is_rewrite else "chapter.continuation_context.build"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = rewrite_scope_context_params(input_data) if is_rewrite else sequence_context_params(input_data)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                raw_context = await self._tool_invoke(run, tool_name, params)
                if is_rewrite:
                    continuation_context = normalize_rewrite_scope_bundle(raw_context, input_data).model_dump()
                else:
                    continuation_context = raw_context
                    if not isinstance(continuation_context, dict):
                        raise ValueError("Continuation context is not an object")
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id, retryable=True) from error
            summary = self._summarize_result(tool_name, continuation_context)
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "continuationContext": continuation_context,
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
                },
                "action": "continue",
                "resume_response": None,
            }

        if not chain_state.get("beats"):
            if input_data.beats:
                beats = input_data.beats
                source = "toolchain_input"
            else:
                node_id = "beats.generate"
                tool_name = "agent.generate_chapter_beats"
                self._require_toolchain_tool(definition, tool_name, node_id)
                if int(chain_state.get("modelCallCount") or 0) >= definition.budget.maxModelCalls:
                    raise ToolchainError("BUDGET_EXCEEDED", "Chapter beat generation budget exhausted", node_id=node_id)
                params = beat_generation_params(input_data, chain_state["continuationContext"])
                if is_rewrite:
                    params.update({
                        "taskMode": "batch_rewrite",
                        "targetChapterIds": input_data.chapterIds,
                    })
                await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name, kind="model")
                await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
                try:
                    raw_beats = await self._tool_invoke(run, tool_name, params)
                    beats = normalize_beat_inputs(raw_beats, input_data.chapterCount)
                except Exception as error:
                    await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                    if isinstance(error, ToolchainError):
                        raise
                    raise ToolchainError("NODE_FAILED", str(error), node_id=node_id, retryable=True) from error
                summary = f"已生成 {len(beats)} 章节拍，等待建立草稿批次。"
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
                source = "model"
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": "beats.generate",
                    "summary": f"{len(beats)} 章节拍已就绪",
                    "source": source,
                    "beats": [beat.model_dump() for beat in beats],
                },
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "beats": [beat.model_dump() for beat in beats],
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + (0 if input_data.beats else 1),
                    "modelCallCount": int(chain_state.get("modelCallCount") or 0) + (0 if input_data.beats else 1),
                },
                "action": "continue",
                "resume_response": None,
            }

        beats = normalize_beat_inputs(chain_state["beats"], input_data.chapterCount)
        if input_data.resumeBatchId and not chain_state.get("draftBatch"):
            node_id = "batch.prepare_regeneration"
            tool_name = "draft.batch.prepare_regeneration"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = batch_regeneration_params(input_data, run.runId)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                prepared_batch, from_child_index, preserved_drafts = normalize_regeneration_preparation(
                    await self._tool_invoke(run, tool_name, params),
                    node_id,
                )
            except SideEffectResultUnknown as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "SIDE_EFFECT_UNKNOWN",
                    str(error),
                    node_id=node_id,
                    details={"invocationKey": error.invocation_key, "method": error.method},
                ) from error
            except ToolchainError:
                raise
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id) from error
            if prepared_batch.draftBatchId != input_data.resumeBatchId:
                raise ToolchainError("NODE_FAILED", "Prepared the wrong draft batch", node_id=node_id)
            if is_rewrite:
                assert_rewrite_batch_alignment(
                    prepared_batch,
                    input_data,
                    normalize_rewrite_scope_bundle(chain_state["continuationContext"], input_data),
                )
            run.draftBatchId = prepared_batch.draftBatchId
            summary = f"已保留前 {from_child_index} 章，从第 {from_child_index + 1} 章重新生成。"
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": summary,
                    "draftBatchId": prepared_batch.draftBatchId,
                    "fromChildIndex": from_child_index,
                },
            )
            self._save()
            return {
                "toolchain_state": {
                    **chain_state,
                    "draftBatch": prepared_batch.model_dump(),
                    "generatedDrafts": preserved_drafts,
                    "regenerationPrepared": True,
                    "regenerationFromChildIndex": from_child_index,
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
                },
                "action": "continue",
                "resume_response": None,
            }

        if not chain_state.get("draftBatch"):
            node_id = "batch.create"
            tool_name = "draft.batch.create"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = (
                rewrite_batch_create_params(
                    input_data,
                    beats,
                    normalize_rewrite_scope_bundle(chain_state["continuationContext"], input_data),
                    run.runId,
                )
                if is_rewrite
                else batch_create_params(input_data, beats, chain_state["continuationContext"], run.runId)
            )
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                raw_batch = await self._tool_invoke(run, tool_name, params)
                batch = normalize_draft_batch(raw_batch, node_id)
                if is_rewrite:
                    assert_rewrite_batch_alignment(
                        batch,
                        input_data,
                        normalize_rewrite_scope_bundle(chain_state["continuationContext"], input_data),
                    )
            except SideEffectResultUnknown as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "SIDE_EFFECT_UNKNOWN",
                    str(error),
                    node_id=node_id,
                    details={"invocationKey": error.invocation_key, "method": error.method},
                ) from error
            run.draftBatchId = batch.draftBatchId
            summary = (
                f"已创建 {len(batch.children)} 章改写批次，等待修订节拍确认。"
                if is_rewrite
                else f"已创建 {len(batch.children)} 章草稿批次，等待节拍确认。"
            )
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": summary,
                    "draftBatchId": batch.draftBatchId,
                    "outlineRevision": batch.outline.revision,
                },
            )
            self._save()
            return {
                "toolchain_state": {
                    **chain_state,
                    "draftBatch": batch.model_dump(),
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
                },
                "action": "continue",
                "resume_response": None,
            }

        batch = normalize_draft_batch(chain_state["draftBatch"], "batch.read")
        run.draftBatchId = batch.draftBatchId
        is_regeneration = bool(input_data.resumeBatchId)
        if not is_regeneration and not chain_state.get("beatsApprovalRequested"):
            checkpoint = chapter_beats_checkpoint(step.stepId, batch)
            await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
            return {
                "toolchain_state": {**chain_state, "beatsApprovalRequested": True},
                "checkpoint": checkpoint,
                "action": "waiting_approval",
                "resume_response": None,
            }

        if not is_regeneration and not self._has_approval_choice(run, "chapter_beats", "approve_beats"):
            raise ToolchainError("INPUT_INVALID", "Chapter beats were not approved", node_id="beats.approve")

        if batch.outline.status != "approved":
            node_id = "beats.approve"
            tool_name = "draft.batch.approve_outline"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = {
                "draftBatchId": batch.draftBatchId,
                "version": batch.version,
                "outlineRevision": batch.outline.revision,
                "approvedBy": "agent-user",
            }
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                approved = normalize_draft_batch(await self._tool_invoke(run, tool_name, params), node_id)
            except SideEffectResultUnknown as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "SIDE_EFFECT_UNKNOWN",
                    str(error),
                    node_id=node_id,
                    details={"invocationKey": error.invocation_key, "method": error.method},
                ) from error
            summary = f"第 {approved.outline.revision} 版章节节拍已确认。"
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "draftBatch": approved.model_dump(),
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
                },
                "action": "continue",
                "resume_response": None,
            }

        generated_drafts = list(chain_state.get("generatedDrafts") or [])
        child_index = len(generated_drafts)
        if child_index < len(batch.children):
            node_id = f"draft.generate.{child_index}"
            tool_name = "chapter.generate_draft"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = (
                rewrite_child_params(
                    input_data,
                    batch,
                    child_index,
                    normalize_rewrite_scope_bundle(chain_state["continuationContext"], input_data),
                    generated_drafts,
                )
                if is_rewrite
                else sequence_child_params(
                    input_data,
                    batch,
                    child_index,
                    chain_state["continuationContext"],
                    generated_drafts,
                )
            )
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                raw_draft = await self._tool_invoke(run, tool_name, params)
                session, draft_state = normalize_generated_child(
                    raw_draft,
                    child_index,
                    batch.outline.beats[child_index].title,
                    batch.children[child_index].generationRevision,
                )
            except SideEffectResultUnknown as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                invocation_record = self.store.get_invocation(error.invocation_key)
                await self._record_sequence_child_failure(
                    run,
                    step,
                    invocation,
                    definition,
                    batch,
                    child_index,
                    code="SIDE_EFFECT_UNKNOWN",
                    message=str(error),
                    side_effect_unknown=True,
                    invocation_key=error.invocation_key,
                    request_id=invocation_record.requestId if invocation_record else None,
                    method=error.method,
                )
                raise ToolchainError(
                    "SIDE_EFFECT_UNKNOWN",
                    str(error),
                    node_id=node_id,
                    details={
                        "invocationKey": error.invocation_key,
                        "method": error.method,
                        "draftBatchId": batch.draftBatchId,
                        "childIndex": child_index,
                    },
                ) from error
            except ToolchainError:
                raise
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                await self._record_sequence_child_failure(
                    run,
                    step,
                    invocation,
                    definition,
                    batch,
                    child_index,
                    code=str(getattr(error, "code", None) or "GENERATION_FAILED"),
                    message=str(error),
                    side_effect_unknown=False,
                )
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id) from error

            run.draftSessionId = session.draftSessionId
            run.draftBatchId = batch.draftBatchId
            generated_drafts.append(draft_state)
            if len(generated_drafts) > 2:
                for earlier in generated_drafts[:-2]:
                    earlier["generatedText"] = ""
            children = [child.model_copy() for child in batch.children]
            children[child_index] = children[child_index].model_copy(update={
                "status": "draft",
                "draftSessionId": session.draftSessionId,
            })
            batch = batch.model_copy(update={
                "children": children,
                "status": "ready_for_review" if child_index + 1 == len(children) else "generating",
                "stateLedger": advance_batch_state_ledger(batch, child_index, draft_state),
                "version": batch.version + 1,
            })
            summary = session.previewSummary or f"第 {child_index + 1}/{len(children)} 章草稿已生成。"
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "draft_created",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "draftSessionId": session.draftSessionId,
                    "draftBatchId": batch.draftBatchId,
                    "childIndex": child_index,
                    "draftType": session.type,
                    "previewSummary": session.previewSummary,
                    "toolchainId": invocation.id,
                },
            )
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": summary,
                    "draftBatchId": batch.draftBatchId,
                    "childIndex": child_index,
                    "completed": child_index + 1,
                    "total": len(children),
                },
            )
            self._save()
            return {
                "toolchain_state": {
                    **chain_state,
                    "draftBatch": batch.model_dump(),
                    "generatedDrafts": generated_drafts,
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
                },
                "action": "continue",
                "resume_response": None,
            }

        if not chain_state.get("batchVerified"):
            node_id = "batch.verify"
            tool_name = "draft.batch.get"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = {"draftBatchId": batch.draftBatchId}
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                verified = normalize_draft_batch(await self._tool_invoke(run, tool_name, params), node_id)
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id, retryable=True) from error
            if (
                verified.status != "ready_for_review"
                or any(child.status not in {"draft", "committed"} for child in verified.children)
            ):
                raise ToolchainError("NODE_FAILED", "Draft batch is incomplete after generation", node_id=node_id)
            summary = f"{len(verified.children)} 章草稿已全部生成并进入批次审核。"
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "draftBatch": verified.model_dump(),
                    "batchVerified": True,
                    "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1,
                },
                "action": "continue",
                "resume_response": None,
            }

        if not chain_state.get("artifactId"):
            batch = normalize_draft_batch(chain_state["draftBatch"], "batch.publish")
            session_ids = [
                str(item.get("draftSessionId") or "")
                for item in chain_state.get("generatedDrafts") or []
                if str(item.get("draftSessionId") or "")
            ]
            summary = (
                f"已生成 {len(session_ids)} 章改写草稿，等待批次审核。"
                if is_rewrite
                else f"已生成 {len(session_ids)} 章连续草稿，等待批次审核。"
            )
            artifact = await self._publish_artifact(
                run,
                artifact_type="chapter_draft_batch",
                title="多章节改写草稿" if is_rewrite else "多章节续写草稿",
                summary=summary,
                reference={"draftBatchId": batch.draftBatchId, "draftSessionIds": session_ids},
                metadata={
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                    "draftBatch": batch.model_dump(),
                    "generatedDrafts": [
                        {key: value for key, value in item.items() if key != "generatedText"}
                        for item in chain_state.get("generatedDrafts") or []
                    ],
                },
                step_id=step.stepId,
                agent=step.agent,
                tool_name="draft.batch.get",
            )
            result = ChapterDraftBatchResult(
                draftBatchId=batch.draftBatchId,
                status=batch.status,
                outlineRevision=batch.outline.revision,
                draftSessionIds=session_ids,
                generatedCount=len(session_ids),
                totalCount=len(batch.children),
                artifactId=artifact.artifactId,
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "artifactId": artifact.artifactId,
                    "batchResult": result.model_dump(),
                },
                "action": "continue",
                "resume_response": None,
            }

        return await self._complete_toolchain(
            run,
            plan,
            step,
            graph_state,
            chain_state,
            definition,
            chain_state["batchResult"],
            artifact_id=str(chain_state.get("artifactId") or "") or None,
            tool_call_count=int(chain_state.get("toolCallCount") or 0),
        )

    async def _advance_creative_asset_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
        chain_state: dict[str, Any],
        definition: Any,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Creative asset draft has no Toolchain invocation")
        input_data = CreativeAssetDraftInput.model_validate(chain_state.get("toolchainInput") or {})
        node_index = int(chain_state.get("nodeIndex") or 0)

        if node_index < len(CREATIVE_CONTEXT_NODES):
            node_id = CREATIVE_CONTEXT_NODES[node_index]
            call_count = int(chain_state.get("toolCallCount") or 0)
            estimated_tokens = int(chain_state.get("estimatedTokens") or 0)
            input_budget = chain_state.get("toolchainInput", {}).get("maxEstimatedTokens")
            max_tokens = min(definition.budget.maxEstimatedTokens, int(input_budget)) if input_budget else definition.budget.maxEstimatedTokens
            if call_count >= definition.budget.maxToolCalls or estimated_tokens >= max_tokens:
                reason = (
                    f"Toolchain 预算已用尽，跳过剩余资料源：calls {call_count}/{definition.budget.maxToolCalls}, "
                    f"tokens {estimated_tokens}/{max_tokens}。"
                )
                updated = exhaust_creative_budget(chain_state, reason)
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="skipped",
                    payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": reason, "code": "BUDGET_EXCEEDED"},
                )
                return {"toolchain_state": updated, "action": "continue", "resume_response": None}
            tool_name, params = build_creative_tool_call(node_id, chain_state)
            self._require_toolchain_tool(definition, tool_name, node_id)
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                result = await self._tool_invoke(run, tool_name, params)
                updated = apply_creative_result(chain_state, node_id, result)
                summary = self._summarize_result(tool_name, result)
                await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
                status = "completed"
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                updated = apply_creative_failure(chain_state, node_id, error)
                summary = str(error)
                status = "partial"
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status=status,
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        context = build_creative_context(chain_state)
        if not chain_state.get("conflictChecked"):
            node_id = "conflict.preflight"
            await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="transform")
            updated = {
                **chain_state,
                "conflictChecked": True,
                "preflightConflicts": [item.model_dump() for item in context.conflicts],
            }
            summary = (
                f"发现 {len(context.conflicts)} 个潜在同名冲突，已加入生成约束。"
                if context.conflicts
                else "未发现明显同名冲突。"
            )
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("creativeDirectionChecked"):
            if int(chain_state.get("modelCallCount") or 0) >= definition.budget.maxModelCalls:
                raise ToolchainError(
                    "BUDGET_EXCEEDED",
                    "Creative asset draft exhausted its model decision budget.",
                    node_id="direction.check",
                )
            analysis_summary = (
                f"已读取情节线 {len(context.plotlines)}、角色 {len(context.characters)}、"
                f"世界设定 {len(context.worldSettings)}、物品 {len(context.items)}、地图 {len(context.maps)}；"
                f"发现潜在冲突 {len(context.conflicts)} 项。"
            )
            try:
                checkpoint = await self._creative_direction_checkpoint(
                    run,
                    step.stepId,
                    plan.goal,
                    plan.title,
                    step.title,
                    analysis_summary,
                    graph_state["locale"],
                )
            except Exception as error:
                raise ToolchainError(
                    "NODE_FAILED",
                    f"Creative direction check failed: {error}",
                    node_id="direction.check",
                    retryable=True,
                ) from error
            updated = {
                **chain_state,
                "creativeDirectionChecked": True,
                "modelCallCount": int(chain_state.get("modelCallCount") or 0) + 1,
            }
            if checkpoint:
                await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                return {
                    "toolchain_state": updated,
                    "checkpoint": checkpoint,
                    "action": "waiting_approval",
                    "resume_response": None,
                }
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("brief"):
            node_id = "brief.assemble"
            await self._emit_toolchain_node_started(run, step, invocation, node_id, kind="transform")
            brief = build_creative_brief(
                input_data,
                context,
                self._latest_approval_summary(run, "creative_direction"),
            )
            updated = {**chain_state, "brief": brief}
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": brief[:240]},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("draftResult"):
            node_id = "draft.generate"
            tool_name = "creative_assets.generate_draft"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = creative_generation_params(input_data, str(chain_state["brief"]))
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                raw_draft = await self._tool_invoke(run, tool_name, params)
                session = normalize_creative_draft(raw_draft)
            except SideEffectResultUnknown as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "SIDE_EFFECT_UNKNOWN",
                    str(error),
                    node_id=node_id,
                    details={"invocationKey": error.invocation_key, "method": error.method},
                ) from error
            except ToolchainError:
                raise
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id) from error
            run.draftSessionId = session.draftSessionId
            summary = session.previewSummary or "创作素材草稿已生成，正在校验。"
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            await self._emit(
                run,
                "draft_created",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={
                    "draftSessionId": session.draftSessionId,
                    "draftType": session.type,
                    "previewSummary": session.previewSummary,
                    "toolchainId": invocation.id,
                },
            )
            updated = {**chain_state, "draftResult": session.model_dump()}
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": summary},
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        if not chain_state.get("validation"):
            node_id = "draft.validate"
            tool_name = "creative_assets.validate_draft"
            self._require_toolchain_tool(definition, tool_name, node_id)
            draft_session = normalize_creative_draft(chain_state["draftResult"])
            params: dict[str, Any] = {"draftSessionId": draft_session.draftSessionId}
            if draft_session.version is not None:
                params["version"] = draft_session.version
            await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name)
            await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
            try:
                raw_validation = await self._tool_invoke(run, tool_name, params)
                validated_session, validation = normalize_creative_validation(
                    raw_validation,
                    draft_session.draftSessionId,
                )
            except SideEffectResultUnknown as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "SIDE_EFFECT_UNKNOWN",
                    str(error),
                    node_id=node_id,
                    details={"invocationKey": error.invocation_key, "method": error.method},
                ) from error
            except ToolchainError:
                raise
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError("NODE_FAILED", str(error), node_id=node_id) from error

            summary = (
                "创作素材草稿校验通过。"
                if validation["ok"]
                else f"草稿保留供审核，校验发现 {len(validation['errors'])} 个问题。"
            )
            await self._emit_tool_success(run, step, invocation, node_id, tool_name, summary)
            artifact = await self._publish_artifact(
                run,
                artifact_type="creative_assets_draft",
                title="创作素材草稿",
                summary=validated_session.previewSummary or summary,
                reference={"draftSessionId": validated_session.draftSessionId},
                metadata={
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                    "draftSession": validated_session.model_dump(),
                    "validation": validation,
                    "context": context.model_dump(),
                },
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
            )
            result = DraftToolchainResult(
                draftSessionId=validated_session.draftSessionId,
                draftType=validated_session.type,
                status=validated_session.status,
                version=validated_session.version,
                previewSummary=validated_session.previewSummary,
                artifactId=artifact.artifactId,
                validation=validation,
                warnings=[*context.warnings, *validation["warnings"]],
                contextStats={
                    "toolCallCount": context.toolCallCount + 2,
                    "estimatedTokens": context.estimatedTokens,
                    "preflightConflictCount": len(context.conflicts),
                },
            )
            updated = {
                **chain_state,
                "draftResult": validated_session.model_dump(),
                "validation": validation,
                "result": result.model_dump(),
                "artifactId": artifact.artifactId,
            }
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=tool_name,
                status="completed" if validation["ok"] else "partial",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": summary,
                    "artifactId": artifact.artifactId,
                    "validationOk": validation["ok"],
                },
            )
            return {"toolchain_state": updated, "action": "continue", "resume_response": None}

        return await self._complete_draft_toolchain(
            run,
            plan,
            step,
            graph_state,
            chain_state,
            definition,
            chain_state.get("result") or {},
            artifact_id=str(chain_state.get("artifactId") or "") or None,
        )

    async def _complete_draft_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
        chain_state: dict[str, Any],
        definition: Any,
        output: Any,
        *,
        artifact_id: str | None,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Draft Toolchain invocation is missing")
        return await self._complete_toolchain(
            run,
            plan,
            step,
            graph_state,
            chain_state,
            definition,
            output,
            artifact_id=artifact_id,
            tool_call_count=int(chain_state.get("toolCallCount") or 0)
            + (2 if invocation.id == "creative_asset.draft" else 1),
        )

    async def _complete_toolchain(
        self,
        run: AgentRun,
        plan: AgentPlan,
        step: Any,
        graph_state: ExecutionState,
        chain_state: dict[str, Any],
        definition: Any,
        output: Any,
        *,
        artifact_id: str | None,
        tool_call_count: int,
    ) -> dict[str, Any]:
        invocation = step.toolchain
        if invocation is None:
            raise ToolchainError("INPUT_INVALID", "Toolchain invocation is missing")
        await self._emit(
            run,
            "toolchain_completed",
            step_id=step.stepId,
            agent=step.agent,
            status="completed",
            payload={
                "toolchainId": invocation.id,
                "version": invocation.version,
                "title": definition.title,
                "artifactId": artifact_id,
                "toolCallCount": tool_call_count,
                "estimatedTokens": int(chain_state.get("estimatedTokens") or 0),
            },
        )
        findings = [
            *graph_state["report_findings"],
            {
                "toolName": f"toolchain:{invocation.id}@{invocation.version}",
                "stepTitle": step.title,
                "data": self._compact_report_result(output),
            },
        ]
        return {
            "phase": "finish_step",
            "report_findings": findings,
            "toolchain_state": chain_state,
            "action": "continue",
            "resume_response": None,
        }

    @staticmethod
    def _require_toolchain_tool(definition: Any, tool_name: str, node_id: str) -> None:
        if tool_name not in definition.requiredTools:
            raise ToolchainError(
                "TOOL_NOT_ALLOWED",
                f"Tool {tool_name} is not registered for {definition.id}@{definition.version}",
                node_id=node_id,
            )

    async def _emit_toolchain_node_started(
        self,
        run: AgentRun,
        step: Any,
        invocation: Any,
        node_id: str,
        *,
        tool_name: str | None = None,
        kind: str = "tool",
    ) -> None:
        await self._emit(
            run,
            "toolchain_node_started",
            step_id=step.stepId,
            agent=step.agent,
            tool_name=tool_name,
            status="running",
            payload={
                "toolchainId": invocation.id,
                "version": invocation.version,
                "nodeId": node_id,
                "kind": kind,
            },
        )

    async def _emit_tool_call(
        self,
        run: AgentRun,
        step: Any,
        invocation: Any,
        node_id: str,
        tool_name: str,
        params: dict[str, Any],
    ) -> None:
        await self._emit(
            run,
            "tool_call",
            step_id=step.stepId,
            agent=step.agent,
            tool_name=tool_name,
            status="running",
            payload={
                "summary": f"正在调用 {tool_name}",
                "transport": self.tool_transport,
                "args": params,
                "toolchainId": invocation.id,
                "nodeId": node_id,
            },
        )

    async def _emit_tool_success(
        self,
        run: AgentRun,
        step: Any,
        invocation: Any,
        node_id: str,
        tool_name: str,
        summary: str,
    ) -> None:
        await self._emit(
            run,
            "tool_result",
            step_id=step.stepId,
            agent=step.agent,
            tool_name=tool_name,
            status="completed",
            payload={
                "summary": summary,
                "transport": self.tool_transport,
                "toolchainId": invocation.id,
                "nodeId": node_id,
            },
        )

    async def _emit_tool_failure(
        self,
        run: AgentRun,
        step: Any,
        invocation: Any,
        node_id: str,
        tool_name: str,
        error: Exception,
    ) -> None:
        await self._emit(
            run,
            "tool_result",
            step_id=step.stepId,
            agent=step.agent,
            tool_name=tool_name,
            status="failed",
            payload={
                "summary": str(error),
                "code": getattr(error, "code", None),
                "transport": self.tool_transport,
                "toolchainId": invocation.id,
                "nodeId": node_id,
            },
        )

    @staticmethod
    def _latest_approval_summary(run: AgentRun, checkpoint_type: str) -> str:
        response = next(
            (
                item
                for item in reversed(run.approvalResponses)
                if item.get("checkpointType") == checkpoint_type
            ),
            {},
        )
        return str(response.get("summary") or response.get("freeText") or "").strip()

    @staticmethod
    def _context_summary(context_bundle: Any) -> str:
        return (
            f"已读取相邻章节 {len(context_bundle.adjacentChapters)}、情节线 {len(context_bundle.plotlines)}、"
            f"角色 {len(context_bundle.characters)}、世界设定 {len(context_bundle.worldSettings)}、"
            f"物品 {len(context_bundle.items)}，证据 {len(context_bundle.evidence)} 条。"
        )

    def _analysis_scope_checkpoint(self, step_id: str) -> dict[str, Any]:
        return {
            "checkpointId": new_id("chk"),
            "checkpointType": "analysis_scope",
            "title": "分析范围",
            "question": "当前任务可以按不同范围分析。请选择后我再继续调用 RAG 和生成报告。",
            "reason": "当前章节与前后铺垫可能有关，只分析当前章更快；扩大范围更稳，但耗时更长。",
            "options": [
                {"id": "current_chapter", "label": "只分析当前章", "description": "速度最快，适合先看本章节奏和问题清单。"},
                {"id": "nearby_chapters", "label": "当前章 + 前后三章", "description": "兼顾上下文铺垫，适合章节质检。"},
                {"id": "volume_structure", "label": "全卷结构分析", "description": "更适合检查长线伏笔、节奏和人物弧线。"},
                {"id": "compare_two_paths", "label": "两个方向分别分析", "description": "分别输出快速质检和扩展范围判断。"},
            ],
            "allowFreeText": True,
            "stepId": step_id,
        }

    def _plotline_scope_checkpoint(
        self,
        step_id: str,
        input_data: PlotlineAnalysisInput,
    ) -> dict[str, Any]:
        options: list[dict[str, str]] = []
        if input_data.chapterId:
            options.append(
                {
                    "id": "plot_current_chapter",
                    "label": "只分析当前章",
                    "description": "读取当前章节与已登记情节线，适合快速定位推进问题。",
                }
            )
        if input_data.volumeId:
            options.append(
                {
                    "id": "plot_current_volume",
                    "label": "分析当前卷",
                    "description": "分批读取本卷章节，检查主支线推进和伏笔回收。",
                }
            )
        options.append(
            {
                "id": "plot_whole_novel",
                "label": "分析整本小说",
                "description": "分批读取全书；覆盖最完整，耗时和上下文开销也最高。",
            }
        )
        return {
            "checkpointId": new_id("chk"),
            "checkpointType": "analysis_scope",
            "title": "确认情节线分析范围",
            "question": "你希望检查当前章、当前卷，还是整本小说的主线、支线与伏笔？",
            "reason": "不同范围会改变需要读取的章节数量；整本分析必须由你明确确认。",
            "options": options,
            "allowFreeText": False,
            "stepId": step_id,
        }

    def _evidence_quality_checkpoint(self, step_id: str, result: Any) -> dict[str, Any] | None:
        if not isinstance(result, dict):
            return None
        confidence = str(result.get("confidence") or "").strip().lower()
        warnings = [str(item).strip() for item in (result.get("warnings") or []) if str(item).strip()]
        evidence = result.get("evidence")
        evidence_is_empty = isinstance(evidence, list) and not evidence
        if confidence != "low" and not warnings and not evidence_is_empty:
            return None
        reasons: list[str] = []
        if confidence == "low":
            reasons.append("模型将当前结论标记为低置信度")
        if evidence_is_empty:
            reasons.append("没有检索到可引用证据")
        if warnings:
            reasons.append(f"检索返回警告：{'；'.join(warnings[:3])}")
        return {
            "checkpointId": new_id("chk"),
            "checkpointType": "evidence_quality",
            "title": "证据不足",
            "question": "当前分析证据不足或存在警告。是否仍基于现有结论生成草稿？",
            "reason": "；".join(reasons),
            "options": [
                {"id": "continue_draft", "label": "谨慎继续生成草稿", "description": "保留低置信度提示，并继续生成可审核草稿。"},
                {"id": "report_only", "label": "只保留分析报告", "description": "跳过后续草稿生成，不写入任何正文。"},
            ],
            "allowFreeText": False,
            "stepId": step_id,
        }

    async def _creative_direction_checkpoint(
        self,
        run: AgentRun,
        step_id: str,
        goal: str,
        plan_title: str,
        step_title: str,
        analysis_summary: str,
        locale: str,
    ) -> dict[str, Any] | None:
        result = await self._automation_invoke(
            run,
            "agent.detect_creative_direction",
            {
                "goal": goal,
                "planTitle": plan_title,
                "stepTitle": step_title,
                "analysisSummary": analysis_summary,
                "locale": locale,
            },
            node_id="creative_direction.detect",
        )
        if not isinstance(result, dict) or result.get("requiresDecision") is not True:
            return None
        raw_options = result.get("options")
        if not isinstance(raw_options, list) or not 2 <= len(raw_options) <= 4:
            raise ValueError("Creative direction detector must return 2 to 4 options")
        options: list[dict[str, str]] = []
        for index, raw_option in enumerate(raw_options):
            if not isinstance(raw_option, dict):
                raise ValueError("Creative direction detector returned an invalid option")
            label = str(raw_option.get("label") or "").strip()[:120]
            if not label:
                raise ValueError("Creative direction option label is required")
            option = {"id": f"direction_{index + 1}", "label": label}
            description = str(raw_option.get("description") or "").strip()[:500]
            if description:
                option["description"] = description
            options.append(option)
        return {
            "checkpointId": new_id("chk"),
            "checkpointType": "creative_direction",
            "title": str(result.get("title") or "创作方向确认").strip()[:120] or "创作方向确认",
            "question": str(result.get("question") or "请选择本次草稿采用的创作方向。").strip()[:500],
            "reason": str(result.get("reason") or "不同方向会显著改变草稿结果，需要由你决定。").strip()[:1000],
            "options": options,
            "allowFreeText": True,
            "stepId": step_id,
        }

    async def _pause_run_for_graph(
        self,
        run: AgentRun,
        step_id: str,
        agent: str,
        checkpoint: dict[str, Any],
    ) -> None:
        run.status = "waiting_approval"
        run.pendingApproval = checkpoint
        self._save()
        await self._emit(
            run,
            "approval_required",
            step_id=step_id,
            agent=agent,
            status="waiting_approval",
            payload=checkpoint,
        )

    def run_status(self, params: dict[str, Any]) -> AgentRunStatusResult:
        run_id = str(params.get("runId") or "")
        run = self.state.runs.get(run_id)
        if not run:
            raise ValueError("runId not found")
        plan = self.state.plans.get(run.planId)
        completed_steps = 0
        current_step_title: str | None = None
        if plan:
            for step in plan.steps:
                if step.status == "completed":
                    completed_steps += 1
                if step.stepId == run.currentStepId:
                    current_step_title = step.title
        last_event = self.store.get_last_event(run.runId)
        return AgentRunStatusResult(
            runId=run.runId,
            planId=run.planId,
            threadId=run.threadId,
            status=run.status,
            currentStepId=run.currentStepId,
            currentStepTitle=current_step_title,
            totalSteps=len(plan.steps) if plan else 0,
            completedSteps=completed_steps,
            lastSequence=last_event.sequence if last_event else 0,
            lastEventAt=last_event.createdAt if last_event else None,
            draftSessionId=run.draftSessionId,
            draftBatchId=run.draftBatchId,
            artifacts=run.artifacts,
            retryOfRunId=run.retryOfRunId,
            retryRootRunId=run.retryRootRunId,
            retryAttempt=run.retryAttempt,
            failureRevision=run.failureRevision,
        )

    async def cancel(self, params: dict[str, Any]) -> AgentRun:
        run_id = str(params.get("runId") or "")
        run = self.state.runs.get(run_id)
        if not run:
            raise ValueError("runId not found")
        was_waiting_approval = run.status == "waiting_approval"
        if run.status in {"running", "waiting_approval"}:
            run.status = "cancelling"
            run.cancelRequested = True
        elif run.status == "cancelling":
            run.cancelRequested = True
        self._save()
        request_ids = list(self._active_request_ids.get(run_id) or set())
        tool_request_ids = set(self._active_tool_request_ids.get(run_id) or set())
        task = self._run_tasks.get(run_id)
        if task and not task.done():
            task.cancel()
        if request_ids:
            async def cancel_request(request_id: str) -> None:
                try:
                    cancel_target = self.tool_adapter if request_id in tool_request_ids else self.automation
                    await cancel_target.cancel(request_id)
                except Exception:
                    # Local task cancellation remains authoritative if the upstream request already ended.
                    pass

            await asyncio.gather(*(cancel_request(request_id) for request_id in request_ids))
        if was_waiting_approval and (not task or task.done()):
            run.pendingApproval = None
            await self._finish_run(run, "cancelled", "run_cancelled", {"reason": "User cancelled pending approval"})
        return run

    async def submit_approval(self, params: dict[str, Any]) -> AgentRun:
        run_id = str(params.get("runId") or "")
        checkpoint_id = str(params.get("checkpointId") or "")
        run = self.state.runs.get(run_id)
        if not run:
            raise ValueError("runId not found")
        pending = run.pendingApproval or {}
        if not pending:
            raise ValueError("No pending approval")
        if checkpoint_id and checkpoint_id != str(pending.get("checkpointId") or ""):
            raise ValueError("checkpointId does not match pending approval")

        response = {
            "checkpointId": str(pending.get("checkpointId") or checkpoint_id),
            "checkpointType": str(pending.get("checkpointType") or "user_decision"),
            "selectedOptionIds": [str(item) for item in (params.get("selectedOptionIds") or [])],
            "freeText": str(params.get("freeText") or "").strip(),
        }
        allowed_option_ids = {str(option.get("id")) for option in (pending.get("options") or [])}
        invalid_option_ids = set(response["selectedOptionIds"]) - allowed_option_ids
        if invalid_option_ids:
            raise ValueError(f"Unknown approval option: {', '.join(sorted(invalid_option_ids))}")
        allow_free_text = pending.get("allowFreeText") is True
        if response["freeText"] and not allow_free_text:
            raise ValueError("This approval checkpoint does not allow free-text responses")
        if not response["selectedOptionIds"] and not (allow_free_text and response["freeText"]):
            raise ValueError("Select an option or provide a free-text response")
        response["summary"] = self._summarize_approval_response(pending, response)
        active_task = self._run_tasks.get(run_id)
        if active_task and not active_task.done():
            await active_task
        run.approvalResponses.append(response)
        run.pendingApproval = None
        if run.status == "waiting_approval":
            run.status = "running"
        await self._emit(
            run,
            "message",
            status="completed",
            payload={
                "kind": "approval_submitted",
                "checkpointId": response["checkpointId"],
                "summary": response["summary"],
                "response": response,
            },
        )
        self._save()
        resume_task = asyncio.create_task(self._run_graph_guarded(run_id, resume=response))
        self._run_tasks[run_id] = resume_task
        return run

    async def event_stream(self, run_id: str, after_sequence: int = 0):
        async for event in self.event_bus.subscribe(run_id, after_sequence):
            yield event

    def _has_approval_choice(self, run: AgentRun, checkpoint_type: str, option_id: str) -> bool:
        return any(
            response.get("checkpointType") == checkpoint_type
            and option_id in (response.get("selectedOptionIds") or [])
            for response in run.approvalResponses
        )

    async def _emit(
        self,
        run: AgentRun,
        event_type,
        *,
        step_id: str | None = None,
        agent=None,
        tool_name: str | None = None,
        status: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> AgentRunEvent:
        event = AgentRunEvent(
            eventId=new_id("evt"),
            runId=run.runId,
            planId=run.planId,
            threadId=run.threadId,
            stepId=step_id,
            type=event_type,
            agent=agent,
            toolName=tool_name,
            status=status,
            payload=payload or {},
        )
        persisted = await self.event_bus.append(event)
        run.events.append(persisted)
        if len(run.events) > 50:
            run.events = run.events[-50:]
        self._save()
        return persisted

    async def _publish_artifact(
        self,
        run: AgentRun,
        *,
        artifact_id: str | None = None,
        artifact_type: str,
        title: str,
        summary: str = "",
        content: str | None = None,
        reference: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        step_id: str | None = None,
        agent=None,
        tool_name: str | None = None,
    ) -> AgentArtifact:
        normalized_reference = reference or {}
        existing = next(
            (
                artifact for artifact in run.artifacts
                if artifact.type == artifact_type and artifact.reference == normalized_reference
            ),
            None,
        )
        if existing:
            return existing
        artifact = AgentArtifact(
            artifactId=artifact_id or new_id("artifact"),
            runId=run.runId,
            planId=run.planId,
            type=artifact_type,
            title=title[:200],
            summary=summary[:2000],
            content=content,
            reference=normalized_reference,
            metadata=metadata or {},
        )
        run.artifacts.append(artifact)
        await self._emit(
            run,
            "artifact_created",
            step_id=step_id,
            agent=agent,
            tool_name=tool_name,
            status="completed",
            payload={"artifact": artifact.model_dump()},
        )
        return artifact

    async def _publish_scope_audit_child(
        self,
        run: AgentRun,
        step: Any,
        invocation: Any,
        bundle: Any,
        *,
        expert: str,
        artifact_type: str,
        title: str,
        summary: str,
        content: str,
        findings: list[ExpertFinding],
        metadata_key: str,
        metadata_value: dict[str, Any],
    ) -> tuple[ExpertReportPayload, AgentArtifact, ScopeAuditExpertRef]:
        reference = {
            "novelId": bundle.scope.novelId,
            "volumeId": bundle.scope.volumeId,
            "chapterId": bundle.scope.anchorChapterId,
            "scopeId": bundle.scope.scopeId,
            "scopeKind": bundle.scope.kind,
            "toolchainId": invocation.id,
            "version": invocation.version,
            "childExpert": expert,
        }
        existing = next(
            (
                item for item in run.artifacts
                if item.type == artifact_type and item.reference == reference
            ),
            None,
        )
        if existing and isinstance(existing.metadata.get("expertReport"), dict):
            existing_report = ExpertReportPayload.model_validate(existing.metadata["expertReport"])
            existing_ref = ScopeAuditExpertRef(
                expert=expert,
                artifactId=existing.artifactId,
                artifactType=artifact_type,
                summary=existing_report.summary or existing.summary,
                findingCount=len(existing_report.findings),
            )
            return existing_report, existing, existing_ref
        artifact_id = new_id("artifact")
        report = ExpertReportPayload(
            artifactId=artifact_id,
            novelId=bundle.scope.novelId,
            runId=run.runId,
            planId=run.planId,
            type=artifact_type,
            title=title,
            expert=expert,
            scope=bundle.scope,
            findings=findings,
            sourceSnapshot=bundle.sourceSnapshot or bundle.scope.snapshot,
            coverage=bundle.coverage,
            summary=summary,
            generatedAt=utc_now(),
        )
        artifact = await self._publish_artifact(
            run,
            artifact_id=artifact_id,
            artifact_type=artifact_type,
            title=title,
            summary=summary[:500],
            content=content,
            reference=reference,
            metadata={
                "expertReport": report.model_dump(),
                metadata_key: metadata_value,
                "scopeAuditChild": True,
                "contextStats": {
                    "estimatedTokens": bundle.estimatedTokens,
                    "coverage": bundle.coverage.model_dump(),
                },
            },
            step_id=step.stepId,
            agent=expert,
        )
        expert_ref = ScopeAuditExpertRef(
            expert=expert,
            artifactId=artifact.artifactId,
            artifactType=artifact_type,
            summary=summary,
            findingCount=len(findings),
        )
        return report, artifact, expert_ref

    async def _finish_run(
        self,
        run: AgentRun,
        final_status: str,
        event_type,
        payload: dict[str, Any],
    ) -> None:
        if final_status == "failed":
            run.failureRevision += 1
            payload = {**payload, "failureRevision": run.failureRevision}
        await self._emit(run, event_type, status=final_status, payload=payload)
        run.status = final_status
        self._save()

    async def _invoke_tool(
        self,
        run: AgentRun,
        tool_name: str,
        goal: str,
        novel_id: str,
        volume_id: str | None,
        chapter_id: str | None,
        current_content: str,
        locale: str,
    ) -> Any:
        if tool_name == "novel.list":
            return await self._tool_invoke(run, tool_name, {})
        if tool_name == "volume.list":
            return await self._tool_invoke(run, tool_name, {"novelId": novel_id})
        if tool_name == "chapter.list":
            if not volume_id:
                return {"skipped": True, "reason": "volumeId missing"}
            return await self._tool_invoke(run, tool_name, {"volumeId": volume_id})
        if tool_name == "chapter.get":
            if not chapter_id:
                return {"skipped": True, "reason": "chapterId missing"}
            return await self._tool_invoke(run, "chapter.get", {"chapterId": chapter_id})
        if tool_name == "rag.ask":
            scope_response = next(
                (response for response in reversed(run.approvalResponses) if response.get("checkpointType") == "analysis_scope"),
                {},
            )
            selected_scope_ids = scope_response.get("selectedOptionIds") or ["current_chapter"]
            analysis_scope = str(selected_scope_ids[0])
            scope_settings = {
                "current_chapter": (8, "只分析当前章节正文，避免把远处情节当成当前章问题。"),
                "nearby_chapters": (14, "结合当前章及前后三章的铺垫和承接进行分析。"),
                "volume_structure": (24, "从当前卷的整体结构、人物弧线和伏笔回收角度分析。"),
                "compare_two_paths": (24, "分别给出仅看当前章和结合扩展上下文的两套判断。"),
            }
            max_evidence_items, scope_instruction = scope_settings.get(analysis_scope, scope_settings["current_chapter"])
            free_text = str(scope_response.get("freeText") or "").strip()
            question_parts = [scope_instruction, f"请从编辑和读者视角分析：{goal}"]
            if free_text:
                question_parts.append(f"用户补充要求：{free_text}")
            return await self._tool_invoke(
                run,
                "rag.ask",
                {
                    "novelId": novel_id,
                    "chapterId": chapter_id,
                    "currentContent": current_content,
                    "question": "\n".join(question_parts),
                    "analysisScope": analysis_scope,
                    "locale": locale,
                    "maxEvidenceItems": max_evidence_items,
                },
            )
        if tool_name == "chapter.generate_draft":
            if not chapter_id:
                return {"skipped": True, "reason": "chapterId missing"}
            return await self._tool_invoke(
                run,
                "chapter.generate_draft",
                {
                    "novelId": novel_id,
                    "chapterId": chapter_id,
                    "currentContent": current_content,
                    "userIntent": self._build_draft_intent(run, goal),
                    "locale": locale,
                    "presentation": "toast",
                },
            )
        if tool_name == "creative_assets.generate_draft":
            return await self._tool_invoke(
                run,
                "creative_assets.generate_draft",
                {
                    "novelId": novel_id,
                    "brief": self._build_draft_intent(run, goal),
                    "locale": locale,
                    "includeExistingEntities": True,
                    "filterCompletedPlotLines": True,
                },
            )
        if tool_name == "search.query":
            return await self._tool_invoke(run, tool_name, {"novelId": novel_id, "keyword": goal})
        if tool_name in {"plotline.list", "character.list", "item.list", "worldsetting.list", "map.list"}:
            return await self._tool_invoke(run, tool_name, {"novelId": novel_id})
        raise ValueError(f"Unsupported Agent tool mapping: {tool_name}")

    async def _tool_invoke(self, run: AgentRun, method: str, params: dict[str, Any]) -> Any:
        definition = AGENT_TOOL_BY_NAME.get(method)
        if definition and not definition.read_only:
            return await self._side_effect_tool_invoke(run, method, params)
        return await self._retryable_request_invoke(
            run,
            method,
            lambda request_id: self.tool_adapter.invoke(
                method,
                params,
                "desktop-ui",
                request_id=request_id,
            ),
            node_id=method,
            tool_request=True,
        )

    async def _side_effect_tool_invoke(self, run: AgentRun, method: str, params: dict[str, Any]) -> Any:
        invocation_key, params_hash = build_invocation_key(run.runId, run.currentStepId, method, params)
        record = self.store.prepare_invocation(
            ToolInvocationRecord(
                invocationKey=invocation_key,
                requestId=new_id("automation"),
                runId=run.runId,
                stepId=run.currentStepId,
                method=method,
                paramsHash=params_hash,
                sideEffect=True,
                status="prepared",
            )
        )
        if record.status in {"succeeded", "reconciled_succeeded"}:
            return record.result
        if record.status in {"in_flight", "unknown"}:
            raise SideEffectResultUnknown(method, invocation_key)
        if record.status in {"failed", "reconciled_absent"}:
            raise RuntimeError(f"Side-effect invocation previously failed: {method} ({invocation_key})")

        in_flight = self.store.mark_invocation_in_flight(invocation_key)
        request_id = in_flight.requestId
        self._active_request_ids.setdefault(run.runId, set()).add(request_id)
        self._active_tool_request_ids.setdefault(run.runId, set()).add(request_id)
        try:
            result = await self.tool_adapter.invoke(method, params, "desktop-ui", request_id=request_id)
            try:
                self.store.mark_invocation_succeeded(
                    invocation_key,
                    self._side_effect_result_snapshot(result),
                )
            except Exception as error:
                try:
                    self.store.mark_invocation_unknown(
                        invocation_key,
                        {"code": "LEDGER_WRITE_FAILED", "message": str(error)},
                    )
                except Exception:
                    pass
                raise SideEffectResultUnknown(method, invocation_key) from error
            return result
        except asyncio.CancelledError:
            try:
                self.store.mark_invocation_unknown(
                    invocation_key,
                    {
                        "code": "CANCELLED_WHILE_IN_FLIGHT",
                        "message": "The run was cancelled while the side-effect request was in flight.",
                    },
                )
            except Exception:
                pass
            raise
        except SideEffectResultUnknown:
            raise
        except Exception as error:
            try:
                self.store.mark_invocation_unknown(
                    invocation_key,
                    {"code": getattr(error, "code", "INVOCATION_ERROR"), "message": str(error)},
                )
            except Exception:
                pass
            raise SideEffectResultUnknown(method, invocation_key) from error
        finally:
            self._discard_active_request(run.runId, request_id, tool_request=True)

    async def _automation_invoke(
        self,
        run: AgentRun,
        method: str,
        params: dict[str, Any],
        *,
        node_id: str | None = None,
    ) -> Any:
        return await self._retryable_automation_invoke(run, method, params, node_id=node_id)

    async def _retryable_automation_invoke(
        self,
        run: AgentRun | None,
        method: str,
        params: dict[str, Any],
        *,
        node_id: str | None = None,
    ) -> Any:
        return await self._retryable_request_invoke(
            run,
            method,
            lambda request_id: self.automation.invoke(
                method,
                params,
                "desktop-ui",
                request_id=request_id,
            ),
            node_id=node_id or method,
        )

    async def _retryable_request_invoke(
        self,
        run: AgentRun | None,
        method: str,
        invoke: Callable[[str], Awaitable[Any]],
        *,
        node_id: str,
        tool_request: bool = False,
    ) -> Any:
        operation_id = new_id("operation")
        request_id = new_id("automation")

        async def request_call() -> Any:
            if run:
                self._active_request_ids.setdefault(run.runId, set()).add(request_id)
                if tool_request:
                    self._active_tool_request_ids.setdefault(run.runId, set()).add(request_id)
            try:
                return await invoke(request_id)
            finally:
                if run:
                    self._discard_active_request(run.runId, request_id, tool_request=tool_request)

        async def on_event(event_type: str, payload: dict[str, Any]) -> None:
            if not run:
                return
            status = "failed" if event_type == "request_retry_exhausted" else (
                "completed" if event_type == "request_retry_succeeded" else "retrying"
            )
            await self._emit(
                run,
                event_type,
                step_id=run.currentStepId,
                tool_name=method if tool_request else None,
                status=status,
                payload=payload,
            )

        return await self.request_graph.run(
            request_call,
            operation_id=operation_id,
            request_id=request_id,
            node_id=node_id,
            method=method,
            on_event=on_event if run else None,
        )

    def _discard_active_request(self, run_id: str, request_id: str, *, tool_request: bool = False) -> None:
        request_ids = self._active_request_ids.get(run_id)
        if request_ids is not None:
            request_ids.discard(request_id)
            if not request_ids:
                self._active_request_ids.pop(run_id, None)
        if tool_request:
            tool_request_ids = self._active_tool_request_ids.get(run_id)
            if tool_request_ids is not None:
                tool_request_ids.discard(request_id)
                if not tool_request_ids:
                    self._active_tool_request_ids.pop(run_id, None)

    @staticmethod
    def _side_effect_result_snapshot(result: Any) -> Any:
        if not isinstance(result, dict):
            return result
        if result.get("draftBatchId") and isinstance(result.get("outline"), dict) and isinstance(result.get("children"), list):
            return result
        if isinstance(result.get("session"), dict) and isinstance(result.get("validation"), dict):
            validation = result["validation"]
            return {
                "session": NovelAgentRuntime._side_effect_result_snapshot(result["session"]),
                "validation": {
                    "ok": validation.get("ok"),
                    "errors": list(validation.get("errors") or []),
                    "warnings": list(validation.get("warnings") or []),
                },
            }
        keys = (
            "draftSessionId",
            "draftBatchId",
            "childIndex",
            "generationRevision",
            "dependsOnDraftSessionId",
            "type",
            "previewSummary",
            "version",
            "status",
        )
        snapshot = {key: result[key] for key in keys if key in result}
        if result.get("draftBatchId") and isinstance(result.get("payload"), dict):
            payload = result["payload"]
            snapshot["payload"] = {
                key: payload[key]
                for key in ("chapterId", "generatedText", "content")
                if key in payload
            }
        return snapshot

    def _build_draft_intent(self, run: AgentRun, goal: str) -> str:
        direction_response = next(
            (response for response in reversed(run.approvalResponses) if response.get("checkpointType") == "creative_direction"),
            None,
        )
        if not direction_response:
            return goal
        summary = str(direction_response.get("summary") or direction_response.get("freeText") or "").strip()
        return f"{goal}\n\n用户确认的创作方向：{summary}" if summary else goal

    def _summarize_result(self, tool_name: str, result: Any) -> str:
        if isinstance(result, dict):
            if result.get("answer"):
                return str(result["answer"])[:240]
            if result.get("previewSummary"):
                return str(result["previewSummary"])
            if result.get("title"):
                return str(result["title"])
        if isinstance(result, list):
            return f"{tool_name} returned {len(result)} items"
        return f"{tool_name} completed"

    def _compact_report_result(self, result: Any, depth: int = 0) -> Any:
        if depth >= 3:
            return str(result)[:500]
        if isinstance(result, dict):
            compact: dict[str, Any] = {}
            preferred_keys = {
                "answer", "summary", "title", "name", "content", "excerpt", "snippet",
                "preview", "confidence", "warnings", "evidence", "issues", "draftSessionId",
                "type", "order", "wordCount", "status", "skipped", "reason",
            }
            for key, value in result.items():
                if key in preferred_keys and value is not None:
                    compact[str(key)] = self._compact_report_result(value, depth + 1)
                if len(compact) >= 16:
                    break
            return compact or {"summary": str(result)[:1000]}
        if isinstance(result, list):
            return [self._compact_report_result(item, depth + 1) for item in result[:20]]
        if isinstance(result, str):
            return result[:2000]
        return result

    def _summarize_approval_response(self, pending: dict[str, Any], response: dict[str, Any]) -> str:
        option_labels: list[str] = []
        selected = set(response.get("selectedOptionIds") or [])
        for option in pending.get("options") or []:
            if str(option.get("id")) in selected:
                option_labels.append(str(option.get("label") or option.get("id")))
        free_text = str(response.get("freeText") or "").strip()
        parts = option_labels + ([free_text] if free_text else [])
        if not parts:
            return "已提交确认。"
        return f"已提交确认：{'；'.join(parts)}"
