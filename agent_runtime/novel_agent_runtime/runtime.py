from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import ValidationError

from .execution_graph import ExecutionState, PlanExecutionGraph
from .exploration_graph import AgentExplorationGraph, ExplorationState
from .events import AgentEventBus
from .agent_skills.service import AGENT_SKILL_SERVICE, AgentSkillService
from .agent_skills.registry import BUILTIN_AGENT_SKILL_REGISTRY, AgentSkillRegistry, AgentSkillRegistration
from .agent_skills.errors import AgentSkillError
from .agent_skills.authoring import (
    AgentSkillAuthorRequest,
    registration_from_persisted,
)
from .agent_skills.schemas import AgentSkillResolveRequest, AgentSkillSelection, ResolvedSkillSet
from .invocations import (
    DraftOperationFailed,
    DraftOperationPending,
    SideEffectResultUnknown,
    ToolInvocationRecord,
    build_durable_operation_key,
    build_invocation_key,
)
from .planner import (
    build_plan_from_intent,
    build_plan_from_model,
    infer_deliverable_effect,
    infer_plan_effect,
    revise_plan_from_model,
    route_plan_from_intent,
    validate_plan_effect,
)
from .request_graph import RetryableRequestGraph
from .retry import AgentRequestError, AgentRequestFailure
from .intent.operations import INTENT_OPERATION_REGISTRY
from .intent.rules import detect_explicit_operations
from .intent.schemas import (
    FailedRunRef,
    IntentConversationState,
    IntentDecision,
    IntentEntryHint,
    IntentRequest,
    ResolvedIntentTarget,
    IntentSelectionContext,
    IntentTargetRef,
    PendingClarificationRef,
    PriorIntentRef,
)
from .intent.service import IntentService
from .intent.targets import resolve_intent_chapter_target
from .roles import list_agent_roles
from .schemas import (
    AgentArtifact,
    AgentChatResponse,
    AgentEvidenceSnapshot,
    AgentMessage,
    AgentPlan,
    AgentPlanStep,
    AgentRecoveryDescriptor,
    AgentRun,
    AgentRunEvent,
    AgentRunStatusResult,
    AgentState,
    AgentUserInputAnswer,
    AgentUserInputEffectiveAnswer,
    AgentUserInputEvidence,
    AgentUserInputOption,
    AgentUserInputQuestion,
    AgentUserInputRequest,
    AgentUserInputResolution,
    ExpertFinding,
    ExpertReportPayload,
    new_id,
    utc_now,
)
from .store import AgentStateStore
from .tool_adapter import AgentToolAdapter, AutomationInvoker, HttpAgentToolAdapter, normalize_tool_arguments
from .automation import AutomationInvokeError
from .tool_manifest import AGENT_TOOL_BY_NAME, AVAILABLE_AGENT_TOOLS, DRAFT_TOOLS, READ_ONLY_AGENT_TOOLS
from .toolchains.registry import TOOLCHAIN_REGISTRY
from .toolchains.chapter_consistency_review import normalize_review, review_markdown, review_request
from .toolchains.builtin_skill_workflows import (
    novel_bootstrap_markdown,
    novel_project_initialization_brief,
    style_skill_pack_markdown,
    workflow_request,
)
from .toolchains.chapter_continuation import (
    build_continuation_context_bundle,
    build_generation_brief,
    chapter_draft_params,
    continuation_context_params,
    normalize_chapter_draft,
)
from .toolchains.chapter_sequence_continuation import (
    MAX_CHAPTER_BEAT_REVISIONS,
    advance_batch_state_ledger,
    batch_create_params,
    batch_regeneration_params,
    beat_generation_params,
    beat_revision_params,
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
    ChapterBeatInput,
    ChapterContextInput,
    ChapterBatchRewriteInput,
    ChapterContinuationInput,
    ChapterDraftBatchResult,
    ChapterSequenceContinuationInput,
    ChapterScopeContextInput,
    ChapterScopeBundle,
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
    NovelBootstrapDraft,
    NovelBootstrapInput,
    NovelProjectInitializeInput,
    StyleSkillPackAuthoringPlan,
    StyleSkillPackDraftArtifact,
    WorldbuildingRangeConsistencyInput,
    WriterRangeRevisionPlanInput,
    ToolchainInvocation,
    ToolchainError,
)


STYLE_SKILL_MEMBER_PATHS = {
    "language_style": "language-style/SKILL.md",
    "suspense_release": "suspense-release/SKILL.md",
    "ensemble_progression": "ensemble-progression/SKILL.md",
}
STYLE_SKILL_MEMBER_KEYS = {
    key: path.split("/", 1)[0] for key, path in STYLE_SKILL_MEMBER_PATHS.items()
}


class NovelAgentRuntime:
    _STRUCTURED_OUTPUT_PROCESSOR_VERSION = "agent-runtime-structured-output-v1"
    _CHAPTER_SCOPE_TOOLCHAINS = {
        "chapter.scope_context",
        "chapter.batch_rewrite",
        "writer.range_revision_plan",
        "editor.range_review",
        "reader.journey_review",
        "worldbuilding.range_consistency",
        "research.range_fact_check",
        "novel.scope_audit",
        "agent_skill.style_extract",
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
        self._persisted_skill_registrations: dict[str, AgentSkillRegistration] = {}
        self._persisted_skill_bindings: list[dict[str, Any]] = []
        self.agent_skill_service = AgentSkillService(BUILTIN_AGENT_SKILL_REGISTRY)
        self.state: AgentState = store.load()
        self._run_tasks: dict[str, asyncio.Task[None]] = {}
        self._operation_watch_tasks: dict[str, asyncio.Task[None]] = {}
        self._operation_watch_timers: dict[str, asyncio.TimerHandle] = {}
        self._active_request_ids: dict[str, set[str]] = {}
        self._active_tool_request_ids: dict[str, set[str]] = {}
        self._active_chat_call_ids: dict[str, set[str]] = {}
        self._model_result_refs: dict[tuple[str, str], dict[str, Any]] = {}
        self._user_input_locks: dict[str, asyncio.Lock] = {}
        self.exploration_graph = AgentExplorationGraph(store.state_dir / "agent_graph.db", READ_ONLY_AGENT_TOOLS)
        self.execution_graph = PlanExecutionGraph(store.state_dir / "agent_graph.db")
        self.request_graph = RetryableRequestGraph()
        self.store.recover_in_flight_invocations()
        self._mark_interrupted_runs()

    def _save(self) -> None:
        self.store.save(self.state)

    def _register_chat_call(self, parent_request_id: str | None, call_id: str) -> None:
        if parent_request_id:
            self._active_chat_call_ids.setdefault(parent_request_id, set()).add(call_id)

    def _unregister_chat_call(self, parent_request_id: str | None, call_id: str) -> None:
        if not parent_request_id:
            return
        calls = self._active_chat_call_ids.get(parent_request_id)
        if not calls:
            return
        calls.discard(call_id)
        if not calls:
            self._active_chat_call_ids.pop(parent_request_id, None)

    async def _invoke_chat_automation(
        self,
        method: str,
        params: dict[str, Any],
        *,
        call_id: str,
        parent_request_id: str | None,
        deadline_at: str,
    ) -> Any:
        try:
            return await self.automation.invoke(
                method,
                params,
                "desktop-ui",
                request_id=call_id,
                parent_request_id=parent_request_id,
                deadline_at=deadline_at,
            )
        except TypeError as error:
            if "unexpected keyword argument" not in str(error):
                raise
            return await self.automation.invoke(method, params, "desktop-ui", request_id=call_id)

    async def _invoke_automation_request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        request_id: str,
        deadline_at: str | None,
    ) -> Any:
        try:
            return await self.automation.invoke(
                method,
                params,
                "desktop-ui",
                request_id=request_id,
                deadline_at=deadline_at,
            )
        except TypeError as error:
            if "unexpected keyword argument" not in str(error):
                raise
            return await self.automation.invoke(
                method,
                params,
                "desktop-ui",
                request_id=request_id,
            )

    def _mark_interrupted_runs(self) -> None:
        changed = False
        for run in self.state.runs.values():
            if run.status not in {"running", "cancelling", "waiting_approval", "waiting_user_input"}:
                continue
            unknown_invocations = self.store.list_invocations(run.runId, statuses={"unknown"})
            durable_record = (
                self.store.get_invocation(run.draftOperationKey)
                if run.draftOperationKey
                else None
            )
            pending_draft_operation = bool(
                durable_record
                and durable_record.invocationKey.startswith("draftop_")
                and durable_record.status in {
                    "prepared",
                    "operation_pending",
                    "succeeded",
                    "failed",
                    "reconciled_succeeded",
                    "reconciled_absent",
                }
                and self.execution_graph.has_checkpoint(f"run:{run.runId}")
            )
            if pending_draft_operation:
                # The Electron operation ledger is authoritative. Re-running the
                # checkpoint will only query/reuse the same stable operation key.
                continue
            if (
                not unknown_invocations
                and run.status in {"waiting_approval", "waiting_user_input"}
                and (run.pendingApproval or run.pendingUserInput)
                and self.execution_graph.has_checkpoint(f"run:{run.runId}")
            ):
                continue
            run.status = "failed"
            run.pendingApproval = None
            run.pendingUserInput = None
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

    async def resume_interrupted_runs(self) -> None:
        """Resume graph checkpoints that were waiting on durable draft operations."""
        for run in self.state.runs.values():
            if run.status not in {"running", "cancelling"} or not run.draftOperationKey:
                continue
            if run.runId in self._run_tasks:
                continue
            checkpoint_state = self.execution_graph.load_checkpoint_state(f"run:{run.runId}")
            if checkpoint_state is None:
                continue
            pending_operation = checkpoint_state.get("pending_operation")
            if checkpoint_state.get("action") == "waiting_operation" and isinstance(pending_operation, dict):
                self._schedule_draft_operation_watcher(run.runId, pending_operation)
                continue
            task = asyncio.create_task(
                self._run_graph_guarded(run.runId, initial_state=checkpoint_state)
            )
            self._run_tasks[run.runId] = task

    def roles(self, params: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        return [role.model_dump() for role in list_agent_roles(locale)]

    async def _refresh_persisted_skills(self, novel_id: str | None) -> None:
        # Built-in skills are bundled with the runtime and must remain available
        # even when the desktop automation bridge is temporarily unavailable.
        try:
            rows = await self.automation.invoke("agent_skill.list", {"novelId": novel_id}, "desktop-ui")
        except AutomationInvokeError:
            return
        if not isinstance(rows, list):
            return
        for row in rows:
            if not isinstance(row, dict) or not row.get("id") or not row.get("revisionId"):
                continue
            try:
                full = await self.automation.invoke(
                    "agent_skill.get",
                    {"skillId": row["id"], "revisionId": row["revisionId"]},
                    "desktop-ui",
                )
            except AutomationInvokeError:
                continue
            if not isinstance(full, dict):
                continue
            try:
                registration = registration_from_persisted(full)
                # Constructing a registry validates roles, operations, toolchains and revisions.
                AgentSkillRegistry([registration])
            except Exception:
                continue
            self._persisted_skill_registrations[registration.definition.id] = registration
        try:
            bindings = await self.automation.invoke(
                "agent_skill.binding.list", {"novelId": novel_id}, "desktop-ui"
            )
        except AutomationInvokeError:
            bindings = []
        self._persisted_skill_bindings = [item for item in bindings if isinstance(item, dict)] if isinstance(bindings, list) else []
        self.agent_skill_service = AgentSkillService(AgentSkillRegistry([
            *BUILTIN_AGENT_SKILL_REGISTRY.registrations(),
            *self._persisted_skill_registrations.values(),
        ]))

    async def skills(self, params: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
        novel_id = str(params.get("novelId") or context.get("novelId") or "").strip() or None
        await self._refresh_persisted_skills(novel_id)
        return self.agent_skill_service.list_public(params, context)

    async def resolve_skill(self, params: dict[str, Any]) -> dict[str, Any]:
        await self._refresh_persisted_skills(str(params.get("novelId") or "").strip() or None)
        return self.agent_skill_service.resolve(params)

    async def preview_skill(self, params: dict[str, Any]) -> dict[str, Any]:
        await self._refresh_persisted_skills(str(params.get("novelId") or "").strip() or None)
        return self.agent_skill_service.preview(params)

    async def author_skill(self, params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        try:
            request = AgentSkillAuthorRequest.model_validate({
                **params,
                "novelId": params.get("novelId") or context.get("novelId"),
                "locale": params.get("locale") or context.get("locale") or "zh-CN",
            })
        except ValidationError as error:
            raise AgentSkillError("AGENT_SKILL_AUTHOR_INPUT_INVALID", str(error)) from error
        request_id = str(context.get("_requestId") or new_id("skill_author"))
        authoring_deadline = (datetime.now(timezone.utc) + timedelta(minutes=8)).isoformat()
        workspace = await self.automation.invoke(
            "agent_skill.workspace.create",
            {
                "action": "update" if request.targetSkillId else "create",
                "scope": request.scope,
                "sourceNovelId": request.novelId,
                "targetSkillId": request.targetSkillId,
                "expectedCurrentRevisionId": request.expectedCurrentRevisionId,
                "derivationReport": {
                    "kind": "natural_language_authoring",
                    "goal": request.goal,
                    "source": request.source,
                },
            },
            "desktop-ui",
            request_id=f"{request_id}:workspace:create",
            parent_request_id=request_id,
            deadline_at=authoring_deadline,
        )
        if not isinstance(workspace, dict) or not workspace.get("draftId"):
            raise AgentSkillError("AGENT_SKILL_DRAFT_PERSIST_FAILED", "Workspace store returned an invalid result")
        diagnostics: list[dict[str, Any]] = []
        for attempt in range(1, 5):
            current = await self.automation.invoke(
                "agent_skill.workspace.read",
                {"draftId": workspace["draftId"], "logicalPath": "SKILL.md"},
                "desktop-ui",
                request_id=f"{request_id}:workspace:read:{attempt}",
                parent_request_id=request_id,
                deadline_at=authoring_deadline,
            )
            current_document = str(current.get("contentText") or "") if isinstance(current, dict) else ""
            generated = await self.automation.invoke(
                "agent.generate_skill_document",
                {
                    **request.model_dump(),
                    "creatorProfile": "builtin.skill-creator",
                    "currentDocument": current_document,
                    "validationDiagnostics": diagnostics,
                    "attempt": attempt,
                },
                "desktop-ui",
                request_id=f"{request_id}:generate:{attempt}",
                parent_request_id=request_id,
                deadline_at=authoring_deadline,
            )
            content_text = str(generated.get("contentText") or "") if isinstance(generated, dict) else ""
            if not content_text:
                raise AgentSkillError("AGENT_SKILL_AUTHOR_OUTPUT_INVALID", "Skill document generator returned empty text")
            workspace = await self.automation.invoke(
                "agent_skill.workspace.write",
                {
                    "draftId": workspace["draftId"],
                    "expectedVersion": workspace["version"],
                    "logicalPath": "SKILL.md",
                    "mediaType": "text/markdown",
                    "contentText": content_text,
                },
                "desktop-ui",
                request_id=f"{request_id}:workspace:write:{attempt}",
                parent_request_id=request_id,
                deadline_at=authoring_deadline,
            )
            workspace = await self.automation.invoke(
                "agent_skill.workspace.validate",
                {
                    "draftId": workspace["draftId"],
                    "expectedVersion": workspace["version"],
                    "finalAttempt": attempt == 4,
                },
                "desktop-ui",
                request_id=f"{request_id}:workspace:validate:{attempt}",
                parent_request_id=request_id,
                deadline_at=authoring_deadline,
            )
            report = workspace.get("validationReport") if isinstance(workspace, dict) else None
            if isinstance(report, dict) and report.get("ok") is True:
                workspace = await self.automation.invoke(
                    "agent_skill.workspace.compile",
                    {"draftId": workspace["draftId"], "expectedVersion": workspace["version"]},
                    "desktop-ui",
                    request_id=f"{request_id}:workspace:compile",
                    parent_request_id=request_id,
                    deadline_at=authoring_deadline,
                )
                persisted = await self.automation.invoke(
                    "agent_skill.draft.get",
                    {"draftId": workspace["draftId"]},
                    "desktop-ui",
                    request_id=f"{request_id}:draft:get",
                    parent_request_id=request_id,
                    deadline_at=authoring_deadline,
                )
                if not isinstance(persisted, dict):
                    raise AgentSkillError("AGENT_SKILL_DRAFT_PERSIST_FAILED", "Draft store returned an invalid result")
                projection = persisted.get("draft") if isinstance(persisted.get("draft"), dict) else {}
                proposal = {
                    "definition": projection.get("definition") or {},
                    "revision": projection.get("revision") or {},
                    "rationale": [],
                    "warnings": [],
                }
                return {
                    "draft": persisted,
                    "workspace": workspace,
                    "proposal": proposal,
                    "requiresReview": True,
                }
            diagnostics = (
                [item for item in report.get("diagnostics", []) if isinstance(item, dict)]
                if isinstance(report, dict) else []
            )
        persisted = await self.automation.invoke(
            "agent_skill.draft.get",
            {"draftId": workspace["draftId"]},
            "desktop-ui",
            request_id=f"{request_id}:draft:attention",
            parent_request_id=request_id,
            deadline_at=authoring_deadline,
        )
        return {
            "draft": persisted,
            "workspace": workspace,
            "proposal": None,
            "requiresReview": False,
            "needsAttention": True,
            "validationReport": workspace.get("validationReport"),
        }

    async def list_skill_drafts(self, params: dict[str, Any], context: dict[str, Any]) -> Any:
        return await self.automation.invoke(
            "agent_skill.draft.list",
            {
                **params,
                "sourceNovelId": params.get("sourceNovelId") or params.get("novelId") or context.get("novelId"),
            },
            "desktop-ui",
        )

    async def get_skill_draft(self, params: dict[str, Any]) -> Any:
        return await self.automation.invoke("agent_skill.draft.get", params, "desktop-ui")

    async def commit_skill_draft(self, params: dict[str, Any]) -> Any:
        return await self.automation.invoke("agent_skill.draft.commit", params, "desktop-ui")

    async def discard_skill_draft(self, params: dict[str, Any]) -> Any:
        return await self.automation.invoke("agent_skill.draft.discard", params, "desktop-ui")

    @staticmethod
    def _step_operation_id(step: AgentPlanStep, decision: IntentDecision | None) -> str | None:
        if step.toolchain is None:
            return None
        definition = TOOLCHAIN_REGISTRY.resolve(step.toolchain.id, step.toolchain.version)
        requested_operations = [item.type for item in decision.operations] if decision else []
        return next(
            (item for item in requested_operations if item in definition.supportedOperations),
            definition.supportedOperations[0] if definition.supportedOperations else None,
        )

    def _apply_agent_skills_to_plan(
        self,
        plan: AgentPlan,
        decision: IntentDecision | None,
        *,
        locale: str,
        novel_id: str | None,
    ) -> AgentPlan:
        requested = list(decision.requestedSkills) if decision else []
        disabled_for_turn = bool(decision.disabledSkillsForTurn) if decision else False
        attached_requested_ids: set[str] = set()
        role_definitions = {item.id: item for item in list_agent_roles(locale)}
        next_steps: list[AgentPlanStep] = []

        for step in plan.steps:
            operation_id = self._step_operation_id(step, decision)
            if not operation_id:
                next_steps.append(step.model_copy(update={"skills": []}))
                continue
            role_id = "team" if step.agent == "supervisor" else step.agent
            matching_explicit: list[AgentSkillSelection] = []
            for item in requested:
                registration = self.agent_skill_service.registry.require(item.skillId)
                if operation_id not in registration.definition.supportedOperations:
                    continue
                matching_explicit.append(AgentSkillSelection(
                    skillId=item.skillId,
                    requestedRevisionId=item.requestedRevisionId,
                    selectionSource=item.selectionSource,
                ))
                attached_requested_ids.add(registration.definition.id)
            bound_skill_ids = [
                str(binding.get("skillId") or "")
                for binding in sorted(
                    self._persisted_skill_bindings,
                    key=lambda item: int(item.get("priority") or 0),
                    reverse=True,
                )
                if binding.get("operationId") == operation_id
                and (not binding.get("roleId") or binding.get("roleId") == role_id)
                and (not binding.get("novelId") or binding.get("novelId") == novel_id)
            ]
            for skill_id in bound_skill_ids:
                if len(matching_explicit) >= 2:
                    break
                if not skill_id or any(item.skillId == skill_id for item in matching_explicit):
                    continue
                matching_explicit.append(AgentSkillSelection(
                    skillId=skill_id,
                    selectionSource="preset",
                ))
                if len(matching_explicit) >= 2:
                    break
            role_definition = role_definitions.get(role_id)
            operation_default_skill_ids = {
                "novel.bootstrap": ["builtin.novel-bootstrap"],
                "novel.project_initialize": ["builtin.novel-bootstrap"],
                "agent_skill.style_extract": ["builtin.style-skill-extractor"],
            }.get(operation_id, [])
            resolved = self.agent_skill_service.resolver.resolve(AgentSkillResolveRequest(
                operationId=operation_id,
                roleId=role_id,
                novelId=novel_id,
                explicitSkills=matching_explicit,
                operationDefaultSkillIds=operation_default_skill_ids,
                defaultSkillIds=list(role_definition.defaultSkillIds if role_definition else []),
                disabledForTurn=disabled_for_turn,
            ))
            next_steps.append(step.model_copy(update={"skills": resolved.refs()}))

        if not disabled_for_turn:
            for item in requested:
                registration = self.agent_skill_service.registry.require(item.skillId)
                if registration.definition.id not in attached_requested_ids:
                    raise AgentSkillError(
                        "AGENT_SKILL_OPERATION_UNSUPPORTED",
                        f"{registration.definition.stableId} is not compatible with this plan",
                    )
        return plan.model_copy(update={"steps": next_steps})

    def _compile_step_skills(self, step: AgentPlanStep) -> dict[str, Any] | None:
        if not step.skills:
            return None
        primary = next((item for item in step.skills if item.position == "primary"), None)
        auxiliary = next((item for item in step.skills if item.position == "auxiliary"), None)
        compiled = self.agent_skill_service.compiler.compile(ResolvedSkillSet(primary=primary, auxiliary=auxiliary))
        return compiled.model_dump()

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
        scope_kind = str(payload.get("kind") or "current_chapter")
        editor_selection = params.get("editorSelection")
        if not isinstance(editor_selection, dict):
            editor_selection = context.get("editorSelection") if isinstance(context.get("editorSelection"), dict) else {}
        scope_chapter_id = str(payload.get("chapterId") or "").strip()
        if scope_kind == "current_chapter" and not scope_chapter_id:
            scope_chapter_id = str(
                editor_selection.get("chapterId") or params.get("chapterId") or context.get("chapterId") or ""
            ).strip()
        raw_scope = {
            **payload,
            "novelId": str(params.get("novelId") or context.get("novelId") or payload.get("novelId") or ""),
            "chapterId": scope_chapter_id or None,
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
            if (
                invocation.id == "agent_skill.style_extract"
                and invocation.input.get("sourceMode") == "named_work_model_prior"
            ):
                next_steps.append(step)
                continue
            scope_input = {key: value for key, value in explicit.items() if key != "experts"}
            if invocation.id == "novel.scope_audit" and explicit.get("experts"):
                scope_input["experts"] = explicit["experts"]
            next_invocation = invocation.model_copy(update={"input": {**invocation.input, **scope_input}})
            next_steps.append(step.model_copy(update={"toolchain": next_invocation}))
        return plan.model_copy(update={"steps": next_steps})

    @staticmethod
    def _apply_resolved_operation_targets(
        plan: AgentPlan,
        decision: IntentDecision | None,
    ) -> AgentPlan:
        if decision is None:
            return plan
        remaining = list(decision.operations)
        next_steps: list[AgentPlanStep] = []
        for step in plan.steps:
            invocation = step.toolchain
            if invocation is None:
                next_steps.append(step)
                continue
            operation_index = next((
                index
                for index, operation in enumerate(remaining)
                if operation.suggestedToolchainId == invocation.id
            ), None)
            if operation_index is None:
                next_steps.append(step)
                continue
            operation = remaining.pop(operation_index)
            target = operation.target
            if target.kind not in {"chapter", "chapter_scope"} or not target.id:
                next_steps.append(step)
                continue
            resolved_target = target.model_dump(exclude_none=True)
            target_input = {
                "chapterId": target.id,
                "_resolvedTarget": resolved_target,
            }
            if target.ids:
                target_input.update({
                    "chapterIds": target.ids,
                    "chapterCount": len(target.ids),
                    "kind": "chapter_range" if len(target.ids) > 1 else "selected_chapters",
                })
            elif invocation.id == "chapter.batch_rewrite":
                target_input.update({
                    "chapterIds": [target.id],
                    "chapterCount": 1,
                    "kind": "selected_chapters",
                })
            if target.volumeId:
                target_input["volumeId"] = target.volumeId
            next_invocation = invocation.model_copy(update={
                "input": {**invocation.input, **target_input},
            })
            next_steps.append(step.model_copy(update={"toolchain": next_invocation}))
        return plan.model_copy(update={"steps": next_steps})

    @staticmethod
    def _apply_fallback_resolved_target(
        plan: AgentPlan,
        target: ResolvedIntentTarget | None,
    ) -> AgentPlan:
        """Attach a deterministic target when a plan was produced without an Intent Toolchain mapping."""
        if target is None or not target.chapterId:
            return plan
        targetable_toolchains = {
            "chapter.context",
            "chapter.consistency_review",
            "chapter.continuation",
            "chapter.sequence_continuation",
            "chapter.batch_rewrite",
        }
        resolved_target = target.model_dump(exclude_none=True)
        next_steps: list[AgentPlanStep] = []
        for step in plan.steps:
            invocation = step.toolchain
            if invocation is None or invocation.id not in targetable_toolchains:
                next_steps.append(step)
                continue
            if (
                invocation.id == "chapter.batch_rewrite"
                and invocation.input.get("chapterIds")
                and target.source in {"current_reference", "operation_default"}
                and not invocation.input.get("_resolvedTarget")
            ):
                # A structured batch selection is the write target. The open
                # editor chapter is only a default for single-target actions.
                next_steps.append(step)
                continue
            target_input: dict[str, Any] = {
                "chapterId": target.chapterId,
                "_resolvedTarget": resolved_target,
            }
            if target.volumeId:
                target_input["volumeId"] = target.volumeId
            if invocation.id == "chapter.batch_rewrite":
                chapter_ids = target.chapterIds or [target.chapterId]
                target_input.update({
                    "chapterIds": chapter_ids,
                    "chapterCount": len(chapter_ids),
                    "kind": "chapter_range" if len(chapter_ids) > 1 else "selected_chapters",
                })
            next_invocation = invocation.model_copy(update={
                "input": {**invocation.input, **target_input},
            })
            next_steps.append(step.model_copy(update={"toolchain": next_invocation}))
        return plan.model_copy(update={"steps": next_steps})

    @staticmethod
    def _apply_novel_project_initialization_source(
        plan: AgentPlan,
        params: dict[str, Any],
    ) -> AgentPlan:
        """Bind the explicitly selected, approved blueprint to initialization only."""
        initialization_steps = [
            step for step in plan.steps
            if step.toolchain and step.toolchain.id == "novel.project_initialize"
        ]
        if not initialization_steps:
            return plan
        artifact_id = str(params.get("bootstrapArtifactId") or "").strip()
        raw_draft = params.get("bootstrapDraft")
        if not artifact_id or not isinstance(raw_draft, dict):
            raise ValueError("初始化项目需要从已确认的小说项目蓝图启动。")
        try:
            draft = NovelBootstrapDraft.model_validate(raw_draft)
        except ValidationError as error:
            raise ValueError("小说项目蓝图无效，无法初始化项目素材。") from error
        next_steps: list[AgentPlanStep] = []
        for step in plan.steps:
            invocation = step.toolchain
            if invocation is None or invocation.id != "novel.project_initialize":
                next_steps.append(step)
                continue
            next_invocation = invocation.model_copy(update={
                "input": {
                    **invocation.input,
                    "bootstrapArtifactId": artifact_id,
                    "bootstrapDraft": draft.model_dump(),
                },
            })
            next_steps.append(step.model_copy(update={"toolchain": next_invocation}))
        return plan.model_copy(update={"steps": next_steps})

    @staticmethod
    def _preserve_resolved_operation_targets(plan: AgentPlan, revised: AgentPlan) -> AgentPlan:
        """Keep approved target snapshots across ordinary plan text/shape revisions."""
        by_step_id: dict[str, dict[str, Any]] = {}
        by_toolchain: dict[str, list[dict[str, Any]]] = {}
        for step in plan.steps:
            invocation = step.toolchain
            if invocation is None or not isinstance(invocation.input.get("_resolvedTarget"), dict):
                continue
            target = dict(invocation.input["_resolvedTarget"])
            by_step_id[step.stepId] = target
            by_toolchain.setdefault(invocation.id, []).append(target)

        next_steps: list[AgentPlanStep] = []
        for step in revised.steps:
            invocation = step.toolchain
            if invocation is None:
                next_steps.append(step)
                continue
            target = by_step_id.get(step.stepId)
            if target is None:
                candidates = by_toolchain.get(invocation.id) or []
                target = candidates.pop(0) if candidates else None
            if not target or not target.get("chapterId"):
                next_steps.append(step)
                continue
            chapter_ids = [str(item) for item in target.get("chapterIds") or [] if str(item)]
            target_input: dict[str, Any] = {
                "chapterId": str(target["chapterId"]),
                "_resolvedTarget": target,
            }
            if target.get("volumeId"):
                target_input["volumeId"] = str(target["volumeId"])
            if invocation.id == "chapter.batch_rewrite":
                chapter_ids = chapter_ids or [str(target["chapterId"])]
                target_input.update({
                    "chapterIds": chapter_ids,
                    "chapterCount": len(chapter_ids),
                    "kind": "chapter_range" if len(chapter_ids) > 1 else "selected_chapters",
                })
            next_invocation = invocation.model_copy(update={
                "input": {**invocation.input, **target_input},
            })
            next_steps.append(step.model_copy(update={"toolchain": next_invocation}))
        return revised.model_copy(update={"steps": next_steps})

    def _qualifies_for_policy_approval(
        self,
        plan: AgentPlan,
        params: dict[str, Any],
        context: dict[str, Any],
    ) -> bool:
        del context
        approval_mode = str(params.get("approvalMode") or "review_required")
        if approval_mode == "chat_only":
            return False
        effect = infer_plan_effect(plan)
        if effect == "read_only":
            return True
        return approval_mode == "full_control" and effect == "draft_write"

    @staticmethod
    def _snapshot_chapters_from_observations(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        chapters: list[dict[str, Any]] = []
        seen: set[str] = set()
        for observation in observations:
            if observation.get("ok") is not True:
                continue
            tool_name = str(observation.get("toolName") or "")
            args = observation.get("args") if isinstance(observation.get("args"), dict) else {}
            result = observation.get("result") if isinstance(observation.get("result"), dict) else {}
            candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
            if tool_name == "chapter.get":
                candidates.append((result, {}))
            elif tool_name == "chapter.scope_context.build":
                snapshots = {
                    str(item.get("chapterId") or ""): item
                    for item in (result.get("sourceSnapshot") or [])
                    if isinstance(item, dict) and item.get("chapterId")
                }
                candidates.extend(
                    (item, snapshots.get(str(item.get("chapterId") or ""), {}))
                    for item in (result.get("chapters") or [])
                    if isinstance(item, dict)
                )
            for value, source_snapshot in candidates:
                chapter_id = str(
                    value.get("chapterId")
                    or value.get("id")
                    or args.get("chapterId")
                    or ""
                )
                if not chapter_id or chapter_id in seen:
                    continue
                seen.add(chapter_id)
                content = str(value.get("content") or "")
                result_value = {**value, "id": value.get("id") or chapter_id, "chapterId": chapter_id}
                if source_snapshot.get("source") == "editor_buffer":
                    result_value["contentSource"] = "editor_snapshot"
                chapters.append({
                    "chapterId": chapter_id,
                    "result": result_value,
                    "ok": True,
                    "sourceVersion": (
                        source_snapshot.get("updatedAt")
                        or source_snapshot.get("version")
                        or value.get("updatedAt")
                        or value.get("version")
                    ),
                    "contentHash": (
                        source_snapshot.get("contentHash")
                        or value.get("contentHash")
                        or hashlib.sha256(content.encode("utf-8")).hexdigest()
                    ),
                })
        return chapters

    def _create_evidence_snapshot(
        self,
        *,
        conversation_id: str,
        storage_conversation_id: str,
        request_id: str | None,
        source_message_id: str | None,
        message: str,
        role: str,
        locale: str,
        explicit_scope: dict[str, Any] | None,
        observations: list[dict[str, Any]],
        context_reads: list[dict[str, Any]],
    ) -> AgentEvidenceSnapshot | None:
        chapters = self._snapshot_chapters_from_observations(observations)
        if not chapters:
            return None
        requested_count = len(explicit_scope.get("chapterIds") or []) if explicit_scope else len(chapters)
        snapshot = AgentEvidenceSnapshot(
            conversationId=conversation_id,
            storageConversationId=storage_conversation_id,
            requestId=request_id,
            sourceMessageId=source_message_id,
            message=message,
            role=role,
            locale=locale,
            chapterScope=explicit_scope or {},
            chapters=chapters,
            contextReads=context_reads,
            contextDiagnostics={
                "requestedChapterCount": requested_count,
                "completedChapterCount": len(chapters),
                "usedEditorSnapshot": any(
                    isinstance(chapter.get("result"), dict)
                    and chapter["result"].get("contentSource") == "editor_snapshot"
                    for chapter in chapters
                ),
            },
        )
        self.state.evidenceSnapshots[snapshot.evidenceSnapshotId] = snapshot
        return snapshot

    def _user_input_evidence(
        self,
        observations: list[dict[str, Any]],
        selection_context: dict[str, Any],
    ) -> list[AgentUserInputEvidence]:
        evidence: list[AgentUserInputEvidence] = []
        seen: set[tuple[str, str]] = set()
        for chapter in self._snapshot_chapters_from_observations(observations):
            result = chapter.get("result") if isinstance(chapter.get("result"), dict) else {}
            source_kind = "editor_snapshot" if result.get("contentSource") == "editor_snapshot" else "chapter"
            source_id = str(chapter.get("chapterId") or "")
            if not source_id:
                continue
            seen.add((source_kind, source_id))
            evidence.append(AgentUserInputEvidence(
                evidenceId=new_id("evidence"),
                sourceKind=source_kind,
                sourceId=source_id,
                title=str(result.get("title") or result.get("chapterTitle") or selection_context.get("chapterTitle") or source_id)[:200],
                version=str(chapter.get("sourceVersion") or "") or None,
                contentHash=str(chapter.get("contentHash") or "") or None,
                coverage="当前编辑器正文快照" if source_kind == "editor_snapshot" else None,
            ))
        source_kinds = {
            "attachment.read": "attachment",
            "rag.ask": "rag",
            "search.query": "search",
            "plotline.list": "creative_setting",
            "character.list": "creative_setting",
            "item.list": "creative_setting",
            "worldsetting.list": "creative_setting",
            "map.list": "creative_setting",
        }
        for observation in observations:
            if observation.get("ok") is not True:
                continue
            tool_name = str(observation.get("toolName") or "")
            source_kind = source_kinds.get(tool_name)
            if not source_kind:
                continue
            args = observation.get("args") if isinstance(observation.get("args"), dict) else {}
            result = observation.get("result") if isinstance(observation.get("result"), dict) else {}
            source_id = str(
                args.get("chapterId")
                or args.get("attachmentId")
                or result.get("id")
                or result.get("chapterId")
                or result.get("attachmentId")
                or tool_name
            )
            key = (source_kind, source_id)
            if key in seen:
                continue
            seen.add(key)
            title = str(result.get("title") or result.get("chapterTitle") or result.get("fileName") or tool_name)
            evidence.append(AgentUserInputEvidence(
                evidenceId=new_id("evidence"),
                sourceKind=source_kind,
                sourceId=source_id,
                title=title[:200],
                version=str(result.get("updatedAt") or result.get("version") or "") or None,
                contentHash=str(result.get("contentHash") or "") or None,
                coverage=str(result.get("actualRange") or result.get("coverage") or "")[:500] or None,
            ))
        return evidence

    def _validate_user_input_evidence(
        self,
        explicit_scope: dict[str, Any] | None,
        observations: list[dict[str, Any]],
        *,
        attachment_focused: bool,
    ) -> None:
        successful = [item for item in observations if item.get("ok") is True]
        if explicit_scope and explicit_scope.get("kind") in {"selected_chapters", "chapter_range"}:
            required = {str(item) for item in (explicit_scope.get("chapterIds") or []) if str(item)}
            read = {str(item.get("chapterId") or "") for item in self._snapshot_chapters_from_observations(successful)}
            missing = sorted(required - read)
            if missing:
                raise ValueError(f"无法在提问前读取全部选中章节：{', '.join(missing)}。请重试读取。")
        if attachment_focused and not any(item.get("toolName") == "attachment.read" for item in successful):
            raise ValueError("无法在提问前读取相关附件内容。请重试读取。")

    def _build_user_input_request(
        self,
        semantic_request,
        *,
        conversation_id: str,
        phase: str,
        evidence: list[AgentUserInputEvidence],
        run_id: str | None = None,
        step_id: str | None = None,
        input_session_id: str | None = None,
        round_number: int = 1,
        max_rounds: int | None = None,
        previous_request_id: str | None = None,
        source_message_id: str | None = None,
    ) -> AgentUserInputRequest:
        evidence_ids = [item.evidenceId for item in evidence]
        questions = [AgentUserInputQuestion(
            questionId=question.questionId,
            header=question.header,
            prompt=question.prompt,
            options=[AgentUserInputOption(
                optionId=option.optionId,
                label=option.label,
                description=option.description,
            ) for option in question.options],
            recommendedOptionId=question.recommendedOptionId,
            recommendationReason=question.recommendationReason,
            evidenceIds=evidence_ids,
            allowCustom=True,
        ) for question in semantic_request.questions]
        return AgentUserInputRequest(
            requestId=new_id("input"),
            inputSessionId=input_session_id or new_id("input_session"),
            conversationId=conversation_id,
            sourceMessageId=source_message_id,
            phase=phase,
            round=round_number,
            maxRounds=max_rounds or (2 if phase == "pre_plan" else 1),
            previousRequestId=previous_request_id,
            title=semantic_request.title,
            reason=semantic_request.reason,
            questions=questions,
            evidence=evidence,
            runId=run_id,
            stepId=step_id,
        )

    async def chat(
        self,
        params: dict[str, Any],
        context: dict[str, Any],
        on_progress: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
        *,
        recovered_payload: dict[str, Any] | None = None,
    ) -> AgentChatResponse:
        message = str(params.get("message") or "").strip()
        conversation_id = str(params.get("conversationId") or new_id("conv"))
        storage_conversation_id = str(
            params.get("storageConversationId") or params.get("agentConversationId") or ""
        ).strip()
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
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        editor_selection = params.get("editorSelection")
        if not isinstance(editor_selection, dict):
            editor_selection = context.get("editorSelection") if isinstance(context.get("editorSelection"), dict) else {}
        editor_chapter_id = str(
            editor_selection.get("chapterId") or params.get("chapterId") or context.get("chapterId") or ""
        ).strip()
        editor_volume_id = str(
            editor_selection.get("volumeId") or params.get("volumeId") or context.get("volumeId") or ""
        ).strip()
        chapter_catalog = params.get("chapterCatalog") or context.get("chapterCatalog")
        requested_target = resolve_intent_chapter_target(
            message,
            chapter_catalog,
            editor_chapter_id=editor_chapter_id or None,
            editor_volume_id=editor_volume_id or None,
        )
        unresolved_project_target = bool(
            requested_target
            and requested_target.source in {"user_message", "structured_selection"}
            and not requested_target.chapterId
        )
        novel_id = str(params.get("novelId") or context.get("novelId") or "").strip()
        authoritative_catalog_selector = bool(
            requested_target
            and requested_target.source in {"user_message", "structured_selection"}
            and requested_target.selector in {"last_in_novel", "last_in_volume", "last_in_current_volume"}
        )
        if (unresolved_project_target or authoritative_catalog_selector) and novel_id:
            try:
                # Relative "last chapter" selectors must be resolved from the
                # authoritative persisted catalog even when the renderer sent a
                # seemingly complete catalog. The authoritative result also
                # carries wordCount/hasContent so the model can distinguish the
                # structural tail from the last written chapter.
                hydrated_catalog = await self.tool_adapter.invoke(
                    "volume.list",
                    {"novelId": novel_id},
                    "desktop-ui",
                )
                hydrated_target = resolve_intent_chapter_target(
                    message,
                    hydrated_catalog,
                    editor_chapter_id=editor_chapter_id or None,
                    editor_volume_id=editor_volume_id or None,
                )
                if hydrated_target and hydrated_target.chapterId:
                    chapter_catalog = hydrated_catalog
                    requested_target = hydrated_target
                elif requested_target:
                    requested_target = ResolvedIntentTarget(
                        selector=requested_target.selector,
                        source=requested_target.source,
                    )
            except Exception:
                if authoritative_catalog_selector and requested_target:
                    # Do not execute a write-capable operation against a stale
                    # renderer target when authoritative validation failed.
                    requested_target = ResolvedIntentTarget(
                        selector=requested_target.selector,
                        source=requested_target.source,
                    )
        target_chapter_id = str(requested_target.chapterId if requested_target else editor_chapter_id or "")
        target_volume_id = str(requested_target.volumeId if requested_target and requested_target.volumeId else editor_volume_id or "")
        exploration_context = {
            "novelId": novel_id,
            "volumeId": target_volume_id,
            "chapterId": target_chapter_id,
            "agentConversationId": str(params.get("agentConversationId") or ""),
        }
        selection_context = {
            **exploration_context,
            "novelTitle": str(params.get("novelTitle") or context.get("novelTitle") or ""),
            "chapterTitle": str(
                requested_target.title if requested_target and requested_target.title
                else params.get("chapterTitle") or context.get("chapterTitle") or ""
            ),
            "currentContent": str(params.get("currentContentText") or "") if target_chapter_id == editor_chapter_id else "",
            "editorSelection": {
                "chapterId": editor_chapter_id or None,
                "volumeId": editor_volume_id or None,
            },
        }
        if requested_target:
            selection_context["operationTarget"] = requested_target.model_dump(exclude_none=True)
        attachment_context = params.get("attachments")
        if isinstance(attachment_context, list) and attachment_context:
            selection_context["attachmentScope"] = {
                "novelId": exploration_context["novelId"],
                "conversationId": exploration_context["agentConversationId"],
            }
            selection_context["attachments"] = [
                {
                    "attachmentId": str(item.get("attachmentId") or item.get("id") or ""),
                    "fileName": str(item.get("fileName") or item.get("originalFileName") or ""),
                    "characterCount": int(item.get("characterCount") or 0),
                }
                for item in attachment_context
                if isinstance(item, dict) and (item.get("attachmentId") or item.get("id"))
            ]
        has_attachments = bool(selection_context.get("attachments"))
        normalized_attachment_message = message.lower()
        attachment_focused = has_attachments and any(marker in normalized_attachment_message for marker in (
            "附件", "文档", "文件", "attachment", "attached", "document", "file",
        ))
        available_read_tools = (
            [
                name for name in READ_ONLY_AGENT_TOOLS
                if (has_attachments or not name.startswith("attachment."))
                and not (has_attachments and name == "attachment.list")
                and (not attachment_focused or name.startswith("attachment."))
            ]
            if approval_mode != "chat_only"
            else []
        )
        available_read_tool_definitions = [
            {
                "name": definition.name,
                "description": definition.description,
                "inputSchema": definition.input_schema,
            }
            for name in available_read_tools
            if (definition := AGENT_TOOL_BY_NAME.get(name)) is not None
        ]
        request_id = str(context.get("_requestId") or params.get("requestId") or "").strip() or None
        deadline_at = str(params.get("deadlineAt") or context.get("deadlineAt") or "").strip()
        if not deadline_at:
            deadline_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        explicit_scope = self._explicit_chapter_scope(params, context, goal=message)
        if explicit_scope:
            selection_context["chapterScope"] = explicit_scope
            declared_count = 3 if re.search(r"(?:这|那|前|后|选中|当前|连续|相邻)?(?<!第)(?:三|3)\s*(?:个)?章", message) else (
                2 if re.search(r"(?:这|那|前|后|选中|当前|连续|相邻)?(?<!第)(?:两|二|2)\s*(?:个)?章", message) else None
            )
            selected_count = len(explicit_scope.get("chapterIds") or [])
            if declared_count is not None and selected_count != declared_count:
                failure_message = f"请求提到 {declared_count} 章，但当前章节范围包含 {selected_count} 章。请重新选择章节范围。"
                history.append(AgentMessage(
                    messageId=str(params.get("messageId") or new_id("message")),
                    role="user",
                    content=message,
                ))
                assistant = AgentMessage(role="assistant", content=failure_message)
                self._save()
                return AgentChatResponse(
                    conversationId=conversation_id,
                    assistantMessage=assistant,
                    status="failed",
                    failure={"code": "SCOPE_CONFLICT", "message": failure_message, "retryable": False},
                )
        read_policy = params.get("readPolicy") or context.get("readPolicy")
        if not isinstance(read_policy, dict):
            normalized_for_policy = message.strip().lower()
            restrict_markers = ("只看", "仅看", "只参考", "仅参考", "不要看其他", "不要参考其他")
            past_only_markers = ("不要看后文", "不要参考后文", "不要看后续", "只看历史", "只读历史")
            restrict_to_scope = any(marker in normalized_for_policy for marker in restrict_markers)
            past_only = any(marker in normalized_for_policy for marker in past_only_markers)
            read_policy = {
                "allowExpansion": not restrict_to_scope,
                "restrictToContextScope": restrict_to_scope,
                "direction": "past" if past_only else "both",
                "source": "user_text" if restrict_to_scope or past_only else "default",
            }
        selection_context["readPolicy"] = read_policy
        restrict_to_context_scope = isinstance(read_policy, dict) and (
            read_policy.get("restrictToContextScope") is True or read_policy.get("allowExpansion") is False
        )
        if restrict_to_context_scope and explicit_scope:
            scope_kind = explicit_scope.get("kind")
            if scope_kind in {"selected_chapters", "chapter_range"}:
                # The model may request evidence, but Runtime owns the immutable range arguments.
                available_read_tools = [
                    name for name in available_read_tools
                    if name not in {"novel.list", "volume.list", "chapter.list", "chapter.get"}
                ]
                if approval_mode != "chat_only" and "chapter.scope_context.build" not in available_read_tools:
                    available_read_tools.append("chapter.scope_context.build")
            elif scope_kind == "current_chapter":
                available_read_tools = [
                    name for name in available_read_tools
                    if name not in {"novel.list", "volume.list", "chapter.list"}
                ]
            elif scope_kind == "current_volume":
                available_read_tools = [
                    name for name in available_read_tools
                    if name not in {"novel.list", "volume.list"}
                ]
            available_read_tool_definitions = [
                {
                    "name": definition.name,
                    "description": definition.description,
                    "inputSchema": definition.input_schema,
                }
                for name in available_read_tools
                if (definition := AGENT_TOOL_BY_NAME.get(name)) is not None
            ]
        model_selection_context = {
            key: value for key, value in selection_context.items() if key != "currentContent"
        }
        active_plan = conversation_context.get("currentPlan")
        active_run = conversation_context.get("activeRun")
        active_run_id = (
            str(active_run.get("runId"))
            if isinstance(active_run, dict) and active_run.get("runId")
            else None
        )
        latest_failed_run = self._latest_retryable_failed_run_ref(
            active_run_id,
            conversation_context.get("priorRuns"),
        )
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
                volumeId=editor_volume_id or None,
                chapterId=editor_chapter_id or None,
                selectedText=str(params.get("selectedText") or "").strip() or None,
            ),
            requestedTarget=requested_target,
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

        recovered_payload_consumed = False

        async def model_call(graph_state: ExplorationState) -> dict[str, Any]:
            nonlocal recovered_payload_consumed
            finalizing = bool(graph_state.get("force_finalization"))
            call_id = new_id("call")
            started_at = time.monotonic()
            self._register_chat_call(request_id, call_id)
            if on_progress:
                await on_progress("finalizing" if finalizing else "thinking", {
                    "type": "model_started",
                    "stage": "finalization" if finalizing else "analysis",
                    "status": "running",
                    "callId": call_id,
                    "displayName": "正在生成读者反馈" if finalizing or graph_state.get("observations") else "正在理解请求",
                })
            try:
                if recovered_payload is not None and not recovered_payload_consumed:
                    recovered_payload_consumed = True
                    result = dict(recovered_payload)
                else:
                    result = await self._invoke_chat_automation(
                        "agent.generate_chat",
                        {
                    "message": message,
                    "messageId": str(params.get("messageId") or ""),
                    "role": role,
                    "approvalMode": approval_mode,
                    "locale": locale,
                    "availableReadTools": [] if finalizing else available_read_tools,
                    "availableReadToolDefinitions": [] if finalizing else available_read_tool_definitions,
                    "availableOperations": INTENT_OPERATION_REGISTRY.list_public(),
                    "intentPreflight": preflight.model_dump(),
                    "selectionContext": model_selection_context,
                    "toolObservations": graph_state["observations"],
                    "explorationNotes": graph_state.get("exploration_notes") or [],
                    "forceFinalization": finalizing,
                    "storageConversationId": storage_conversation_id,
                    "conversationContext": conversation_context,
                    "protectedContext": {
                        "storageConversationId": storage_conversation_id,
                        "selectionContext": model_selection_context,
                        "currentPlan": active_plan,
                        "activeRun": active_run,
                        "conversationPendingUserInput": conversation_context.get("pendingUserInput"),
                        "relatedUserInputResolutions": conversation_context.get("userInputResolutions") or [],
                        "relatedApprovalResponses": (
                            active_run.get("approvalResponses") or []
                            if isinstance(active_run, dict)
                            else []
                        ),
                        "intentPreflight": preflight.model_dump(),
                    },
                        },
                        call_id=call_id,
                        parent_request_id=request_id,
                        deadline_at=deadline_at,
                    )
            except asyncio.CancelledError:
                await self.automation.cancel(call_id)
                if on_progress:
                    await on_progress("finalizing" if finalizing else "thinking", {
                        "type": "model_completed",
                        "stage": "finalization" if finalizing else "analysis",
                        "status": "cancelled",
                        "callId": call_id,
                        "displayName": "模型生成已取消",
                        "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    })
                raise
            except Exception as error:
                if on_progress:
                    await on_progress("finalizing" if finalizing else "thinking", {
                        "type": "model_completed",
                        "stage": "finalization" if finalizing else "analysis",
                        "status": "failed",
                        "callId": call_id,
                        "displayName": "模型生成失败",
                        "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    })
                if str(getattr(error, "code", "")).upper() in {"UPSTREAM_TIMEOUT", "PROVIDER_TIMEOUT"}:
                    return {
                        "content": "",
                        "toolCalls": [],
                        "failureCode": "MODEL_SUMMARY_TIMEOUT",
                        "shouldPlan": False,
                        "needsClarification": False,
                    }
                raise
            else:
                if on_progress:
                    await on_progress("finalizing" if finalizing else "thinking", {
                        "type": "model_completed",
                        "stage": "finalization" if finalizing else "analysis",
                        "status": "completed",
                        "callId": call_id,
                        "displayName": "反馈生成完成",
                        "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    })
            finally:
                self._unregister_chat_call(request_id, call_id)
            if not isinstance(result, dict):
                return {}
            if result.get("shouldPlan") is True:
                return {**result, "toolCalls": []}
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

        dynamic_context_reads: list[dict[str, Any]] = []

        async def tool_call(tool_name: str, tool_args: dict[str, Any]) -> Any:
            call_id = new_id("call")
            started_at = time.monotonic()
            self._register_chat_call(request_id, call_id)
            labels = {
                "chapter.list": "正在获取章节目录",
                "chapter.get": "正在读取章节",
                "chapter.scope_context.build": "正在装配章节范围",
                "rag.ask": "正在检索项目资料",
            }
            if on_progress:
                await on_progress("reading", {
                    "type": "tool_started", "stage": "context_read", "status": "running",
                    "callId": call_id, "toolName": tool_name,
                    "displayName": labels.get(tool_name, f"正在调用 {tool_name}"),
                })
            try:
                effective_args = tool_args
                if tool_name == "chapter.scope_context.build" and explicit_scope:
                    effective_args = {
                        **explicit_scope,
                        "novelId": exploration_context["novelId"],
                        "goal": message,
                        "locale": locale,
                    }
                    chapter_ids = {str(item) for item in (effective_args.get("chapterIds") or [])}
                    current_chapter_id = str(selection_context.get("chapterId") or "")
                    current_content = str(selection_context.get("currentContent") or "")
                    if current_content and current_chapter_id in chapter_ids:
                        effective_args["currentContent"] = current_content
                    tool_args.clear()
                    tool_args.update({
                        key: value for key, value in effective_args.items() if key != "currentContent"
                    })
                if restrict_to_context_scope and explicit_scope and tool_name == "chapter.list":
                    allowed_volume_id = str(explicit_scope.get("volumeId") or "")
                    requested_volume_id = str(effective_args.get("volumeId") or exploration_context.get("volumeId") or "")
                    if allowed_volume_id and requested_volume_id != allowed_volume_id:
                        raise ValueError("READ_POLICY_DENIED: 用户要求不读取初始上下文范围外的章节")
                if restrict_to_context_scope and explicit_scope and tool_name == "chapter.get":
                    requested_chapter_id = str(effective_args.get("chapterId") or "")
                    scope_kind = explicit_scope.get("kind")
                    allowed_chapter_ids = {
                        str(item) for item in (
                            explicit_scope.get("chapterIds")
                            or [explicit_scope.get("chapterId") or explicit_scope.get("anchorChapterId")]
                        )
                        if str(item or "")
                    }
                    if scope_kind in {"current_chapter", "selected_chapters", "chapter_range"} and (
                        requested_chapter_id not in allowed_chapter_ids
                    ):
                        raise ValueError("READ_POLICY_DENIED: 用户要求不读取初始上下文范围外的章节")
                    if scope_kind == "current_volume":
                        allowed_volume_id = str(explicit_scope.get("volumeId") or "")
                        catalog_entry = next((
                            item for item in chapter_catalog
                            if isinstance(item, dict)
                            and str(item.get("chapterId") or item.get("id") or "") == requested_chapter_id
                        ), None) if isinstance(chapter_catalog, list) else None
                        if not catalog_entry or str(catalog_entry.get("volumeId") or "") != allowed_volume_id:
                            raise ValueError("READ_POLICY_DENIED: 用户要求不读取当前卷之外的章节")
                if tool_name == "chapter.get" and read_policy.get("direction") == "past":
                    ordered_ids = [
                        str(item.get("chapterId") or item.get("id") or "")
                        for item in chapter_catalog
                        if isinstance(item, dict) and (item.get("chapterId") or item.get("id"))
                    ] if isinstance(chapter_catalog, list) else []
                    requested_chapter_id = str(effective_args.get("chapterId") or "")
                    if (
                        requested_chapter_id in ordered_ids
                        and target_chapter_id in ordered_ids
                        and ordered_ids.index(requested_chapter_id) > ordered_ids.index(target_chapter_id)
                    ):
                        raise ValueError("READ_POLICY_DENIED: 用户要求不读取目标章节之后的内容")
                result = await self._invoke_exploration_tool(
                    tool_name,
                    effective_args,
                    message,
                    exploration_context,
                    locale,
                    call_id,
                    parent_request_id=request_id,
                    deadline_at=deadline_at,
                )
                if (
                    tool_name == "chapter.get"
                    and isinstance(result, dict)
                    and str(effective_args.get("chapterId") or exploration_context.get("chapterId") or "")
                    == str(selection_context.get("chapterId") or "")
                    and selection_context.get("currentContent")
                ):
                    result = {
                        **result,
                        "content": str(selection_context["currentContent"]),
                        "contentSource": "editor_snapshot",
                    }
                if on_progress:
                    await on_progress("reading", {
                        "type": "tool_completed", "stage": "context_read", "status": "completed",
                        "callId": call_id, "toolName": tool_name,
                        "displayName": labels.get(tool_name, tool_name).replace("正在", "已完成："),
                        "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    })
                dynamic_context_reads.append({
                    "toolName": tool_name,
                    "callId": call_id,
                    "sourceTitle": str(result.get("title") or result.get("chapterTitle") or tool_name) if isinstance(result, dict) else tool_name,
                    "status": "completed",
                    "elapsedMs": round((time.monotonic() - started_at) * 1000),
                })
                return result
            except asyncio.CancelledError:
                await self.tool_adapter.cancel(call_id)
                dynamic_context_reads.append({
                    "toolName": tool_name,
                    "callId": call_id,
                    "sourceTitle": tool_name,
                    "status": "cancelled",
                    "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    "errorCode": "CANCELLED",
                })
                if on_progress:
                    await on_progress("reading", {
                        "type": "tool_failed", "stage": "context_read", "status": "cancelled",
                        "callId": call_id, "toolName": tool_name, "displayName": "工具调用已取消",
                        "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    })
                raise
            except Exception as error:
                dynamic_context_reads.append({
                    "toolName": tool_name,
                    "callId": call_id,
                    "sourceTitle": tool_name,
                    "status": "failed",
                    "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    "errorCode": str(getattr(error, "code", "CONTEXT_READ_FAILED")),
                })
                if on_progress:
                    await on_progress("reading", {
                        "type": "tool_failed", "stage": "context_read", "status": "failed",
                        "callId": call_id, "toolName": tool_name, "displayName": "工具调用失败",
                        "elapsedMs": round((time.monotonic() - started_at) * 1000),
                        "errorCode": str(getattr(error, "code", "CONTEXT_READ_FAILED")),
                    })
                raise
            finally:
                self._unregister_chat_call(request_id, call_id)

        evidence_snapshot: AgentEvidenceSnapshot | None = None

        if self.intent_service.retry_failed_run_action(intent_request) is not None:
            graph_result = {
                "decision": {"content": "resume", "shouldPlan": False, "needsClarification": False},
                "tool_trace": [],
                "audit_observations": [],
            }
        else:
            try:
                deadline_value = datetime.fromisoformat(deadline_at.replace("Z", "+00:00"))
                remaining_request_seconds = max(0.1, (deadline_value - datetime.now(timezone.utc)).total_seconds())
            except ValueError:
                remaining_request_seconds = 300.0
            try:
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
                        audit_observations=[],
                        exploration_notes=[],
                        force_finalization=False,
                        extended=False,
                    ),
                    model_call,
                    tool_call,
                    on_progress=on_progress,
                    soft_iterations=(
                        6 if isinstance(attachment_context, list) and (
                            len(attachment_context) > 1
                            or any(int(item.get("characterCount") or 0) > 12000 for item in attachment_context if isinstance(item, dict))
                        ) else 4
                    ),
                    total_budget_seconds=remaining_request_seconds,
                )
            except Exception as error:
                code = str(getattr(error, "code", "")).upper()
                details = getattr(error, "details", None)
                if code != "MODEL_OUTPUT_INVALID" or not isinstance(details, dict):
                    raise
                model_result_ref = str(details.get("modelResultRef") or "").strip()
                if not model_result_ref:
                    raise
                recovery_ref = new_id("chat_recovery")
                self.state.recoveryRecords[recovery_ref] = {
                    "kind": "chat_model_output",
                    "status": "available",
                    "conversationId": conversation_id,
                    "storageConversationId": storage_conversation_id,
                    "messageId": str(params.get("messageId") or "").strip(),
                    "sourceMethod": "agent.generate_chat",
                    "modelResultRef": model_result_ref,
                    "contractId": details.get("contractId"),
                    "contractVersion": details.get("contractVersion"),
                    "validationIssues": details.get("validationIssues") or [],
                    "automaticRepairAttempts": 1,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                }
                self._save()
                raise AgentRequestError(AgentRequestFailure(
                    code="MODEL_OUTPUT_INVALID",
                    retryable=False,
                    attempts=1,
                    user_message="模型返回的结构不符合要求，自动修复未成功。",
                    diagnostic_ref=new_id("diagnostic"),
                    details={
                        "recoveryRef": recovery_ref,
                        "recoveryAction": "repair_model_output",
                    },
                )) from error
        if dynamic_context_reads:
            enriched_trace: list[dict[str, Any]] = []
            used_dynamic_indexes: set[int] = set()
            for trace_item in graph_result["tool_trace"]:
                if trace_item.get("callId"):
                    enriched_trace.append(trace_item)
                    continue
                match_index = next((
                    index for index in range(len(dynamic_context_reads) - 1, -1, -1)
                    if index not in used_dynamic_indexes
                    and dynamic_context_reads[index].get("toolName") == trace_item.get("toolName")
                    and dynamic_context_reads[index].get("status") == trace_item.get("status")
                ), None)
                if match_index is None:
                    enriched_trace.append(trace_item)
                else:
                    used_dynamic_indexes.add(match_index)
                    enriched_trace.append({**trace_item, **dynamic_context_reads[match_index]})
            graph_result["tool_trace"] = enriched_trace
        audit_observations = list(graph_result.get("audit_observations") or [])
        evidence_snapshot = self._create_evidence_snapshot(
            conversation_id=conversation_id,
            storage_conversation_id=storage_conversation_id,
            request_id=request_id,
            source_message_id=str(params.get("messageId") or "").strip() or None,
            message=message,
            role=role,
            locale=locale,
            explicit_scope=explicit_scope,
            observations=audit_observations,
            context_reads=graph_result["tool_trace"],
        )
        if evidence_snapshot:
            self._save()
        result = graph_result["decision"]
        if isinstance(result, dict) and result.get("failureCode"):
            failure_code = str(result.get("failureCode"))
            completed_reads = len(evidence_snapshot.chapters) if evidence_snapshot else sum(
                1 for item in graph_result["tool_trace"] if item.get("status") == "completed"
            )
            total_reads = (
                len(explicit_scope.get("chapterIds") or [])
                if explicit_scope and explicit_scope.get("kind") in {"selected_chapters", "chapter_range"}
                else len(graph_result["tool_trace"])
            )
            if failure_code == "MODEL_SUMMARY_TIMEOUT":
                failure_message = f"已读取 {completed_reads}/{total_reads} 章，但模型总结超时。" if total_reads else "模型总结超时。"
            else:
                failure_message = "请求未能在总时限内完成。"
            history.append(AgentMessage(
                messageId=str(params.get("messageId") or new_id("message")),
                role="user",
                content=message,
            ))
            assistant = AgentMessage(role="assistant", content=failure_message)
            self._save()
            return AgentChatResponse(
                conversationId=conversation_id,
                assistantMessage=assistant,
                status="failed",
                failure={
                    "code": failure_code,
                    "message": failure_message,
                    "coverage": {"completed": completed_reads, "total": total_reads},
                    "retryable": failure_code == "MODEL_SUMMARY_TIMEOUT" and evidence_snapshot is not None,
                },
                evidenceSnapshotId=evidence_snapshot.evidenceSnapshotId if evidence_snapshot else None,
                contextReads=graph_result["tool_trace"],
            )
        if not isinstance(result, dict) or (
            not str(result.get("content") or "").strip()
            and not isinstance(result.get("inputRequest"), dict)
        ):
            raise ValueError("Agent chat returned an invalid response")
        semantic = self.intent_service.enrich_semantic(
            intent_request,
            self.intent_service.normalize_semantic(result),
        )
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
        pending_user_input: AgentUserInputRequest | None = None
        if awaiting_user_input:
            if semantic.inputRequest is None:
                intent_decision = intent_decision.model_copy(update={
                    "route": "respond",
                    "needsClarification": False,
                    "missingUserDecisions": [],
                    "reasonCodes": [
                        *intent_decision.reasonCodes,
                        "INVALID_CLARIFICATION_DOWNGRADED",
                    ],
                    "responseContent": (
                        "我还不能确定需要你确认的关键选项，请换一种更具体的方式描述任务。"
                        if locale.startswith("zh")
                        else "I could not determine a valid decision for you to confirm. Please describe the task more specifically."
                    ),
                })
                awaiting_user_input = False
                content = intent_decision.responseContent
            else:
                self._validate_user_input_evidence(
                    explicit_scope,
                    audit_observations,
                    attachment_focused=attachment_focused,
                )
                pending_user_input = self._build_user_input_request(
                    semantic.inputRequest,
                    conversation_id=conversation_id,
                    phase="pre_plan",
                    evidence=self._user_input_evidence(audit_observations, selection_context),
                    max_rounds=(
                        3
                        if any(operation.type == "novel.bootstrap" for operation in intent_decision.operations)
                        else 2
                    ),
                    source_message_id=str(params.get("messageId") or "").strip() or None,
                )
        context_compression = result.get("contextCompression")
        if not isinstance(context_compression, dict) or context_compression.get("applied") is not True:
            context_compression = None
        context_diagnostics = result.get("contextDiagnostics")
        if not isinstance(context_diagnostics, dict) or context_diagnostics.get("contextVersion") not in {
            "agent-context-v1", "agent-context-v2"
        }:
            context_diagnostics = None
        history.append(AgentMessage(
            messageId=str(params.get("messageId") or new_id("message")),
            role="user",
            content=message,
        ))
        assistant = AgentMessage(role="assistant", content=content)
        if not awaiting_user_input:
            history.append(assistant)
        if pending_user_input:
            for request_key, pending_entry in list(self.state.pendingUserInputs.items()):
                if pending_entry.get("conversationId") == conversation_id:
                    self.state.pendingUserInputs.pop(request_key, None)
            self.state.pendingUserInputs[pending_user_input.requestId] = {
                "request": pending_user_input.model_dump(),
                "conversationId": conversation_id,
                "planning": {
                    "goal": message,
                    "role": role,
                    "locale": locale,
                    "chapterScope": explicit_scope,
                    "chapterId": exploration_context.get("chapterId") or None,
                    "novelId": exploration_context.get("novelId") or None,
                    "intentDecision": intent_decision.model_dump(),
                    "decisionRounds": [],
                },
            }
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
            intentDecision=intent_decision,
            pendingUserInput=pending_user_input,
            evidenceSnapshotId=evidence_snapshot.evidenceSnapshotId if evidence_snapshot else None,
        )

    async def recover_chat(
        self,
        params: dict[str, Any],
        context: dict[str, Any],
        on_progress: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    ) -> AgentChatResponse:
        recovery_request = params.get("recovery")
        if not isinstance(recovery_request, dict):
            raise ValueError("recovery is required")
        recovery_ref = str(recovery_request.get("recoveryRef") or "").strip()
        recovery = self.state.recoveryRecords.get(recovery_ref)
        if not recovery or recovery.get("kind") != "chat_model_output":
            raise AgentRequestError(AgentRequestFailure(
                code="MODEL_RESULT_NOT_FOUND",
                retryable=False,
                attempts=1,
                user_message="已保存的对话恢复记录不存在或已经失效。",
                diagnostic_ref=new_id("diagnostic"),
            ))
        if recovery.get("status") == "exhausted":
            raise AgentRequestError(AgentRequestFailure(
                code="MODEL_REPAIR_ATTEMPT_EXHAUSTED",
                retryable=False,
                attempts=1,
                user_message="JSON 修复次数已用完，可以直接重新请求模型。",
                diagnostic_ref=new_id("diagnostic"),
                details={"recoveryAction": "retry_request"},
            ))
        expected_storage_conversation_id = str(
            recovery.get("storageConversationId") or recovery.get("conversationId") or ""
        )
        requested_storage_conversation_id = str(
            params.get("storageConversationId")
            or params.get("agentConversationId")
            or params.get("conversationId")
            or ""
        )
        if expected_storage_conversation_id != requested_storage_conversation_id:
            raise ValueError("The recovery record does not belong to this conversation")
        if str(recovery.get("messageId") or "") != str(params.get("messageId") or ""):
            raise ValueError("The recovery record does not belong to this message")
        source_method = str(recovery.get("sourceMethod") or "").strip()
        if source_method != "agent.generate_chat":
            raise ValueError("Only saved Agent chat output can be recovered here")
        node_id = str(recovery.get("nodeId") or "agent.generate_chat").strip()
        try:
            try:
                repaired_payload = await self._reprocess_saved_structured_output(
                    source_method=source_method,
                    node_id=node_id,
                    details=recovery,
                )
            except AgentRequestError as error:
                if error.code != "MODEL_OUTPUT_INVALID":
                    raise
                repaired_payload = await self._repair_saved_structured_output(
                    None,
                    source_method=source_method,
                    node_id=node_id,
                    details=recovery,
                    repair_attempt=2,
                )
        except Exception as error:
            if isinstance(error, AgentRequestError) and error.code == "MODEL_REPAIR_IN_PROGRESS":
                raise AgentRequestError(AgentRequestFailure(
                    code=error.code,
                    retryable=False,
                    attempts=1,
                    user_message=error.failure.user_message,
                    diagnostic_ref=error.failure.diagnostic_ref,
                    details={"recoveryRef": recovery_ref, "recoveryAction": "repair_model_output"},
                )) from error
            self.state.recoveryRecords[recovery_ref] = {**recovery, "status": "exhausted"}
            self._save()
            raise AgentRequestError(AgentRequestFailure(
                code=str(getattr(error, "code", "MODEL_OUTPUT_INVALID")),
                retryable=False,
                attempts=1,
                user_message="已保存回答的 JSON 修复仍未成功，可以直接重新请求模型。",
                diagnostic_ref=(
                    error.failure.diagnostic_ref
                    if isinstance(error, AgentRequestError)
                    else new_id("diagnostic")
                ),
                details={"recoveryAction": "retry_request"},
            )) from error
        chat_params = {key: value for key, value in params.items() if key != "recovery"}
        response = await self.chat(
            chat_params,
            context,
            on_progress=on_progress,
            recovered_payload=repaired_payload,
        )
        self.state.recoveryRecords.pop(recovery_ref, None)
        self._save()
        return response

    async def retry_chat_summary(
        self,
        params: dict[str, Any],
        context: dict[str, Any],
        on_progress: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    ) -> AgentChatResponse:
        snapshot_id = str(params.get("evidenceSnapshotId") or "").strip()
        snapshot = self.state.evidenceSnapshots.get(snapshot_id)
        if snapshot is None:
            raise AgentRequestError(AgentRequestFailure(
                code="EVIDENCE_SNAPSHOT_MISSING",
                retryable=False,
                attempts=1,
                user_message="请求时证据快照已不存在，无法仅重试总结。",
                diagnostic_ref=new_id("diagnostic"),
            ))
        parent_request_id = str(context.get("_requestId") or params.get("requestId") or "").strip() or None
        deadline_at = str(params.get("deadlineAt") or "").strip() or (
            datetime.now(timezone.utc) + timedelta(minutes=5)
        ).isoformat()
        call_id = new_id("call")
        started_at = time.monotonic()
        self._register_chat_call(parent_request_id, call_id)
        if on_progress:
            await on_progress("finalizing", {
                "type": "model_started", "stage": "finalization", "status": "running",
                "callId": call_id, "displayName": "正在基于请求时快照重新生成反馈",
            })
        observations = [
            {
                "toolName": "chapter.get",
                "args": {"chapterId": chapter.get("chapterId")},
                "result": chapter.get("result"),
                "ok": chapter.get("ok") is True,
            }
            for chapter in snapshot.chapters
        ]
        try:
            result = await self._invoke_chat_automation(
                "agent.generate_chat",
                {
                    "message": snapshot.message,
                    "messageId": str(snapshot.sourceMessageId or ""),
                    "storageConversationId": str(
                        params.get("storageConversationId") or snapshot.storageConversationId
                    ).strip(),
                    "role": snapshot.role,
                    "locale": snapshot.locale,
                    "availableReadTools": [],
                    "availableReadToolDefinitions": [],
                    "selectionContext": {"chapterScope": snapshot.chapterScope, "basedOnEvidenceSnapshot": snapshot_id},
                    "toolObservations": observations,
                    "explorationNotes": [],
                    "forceFinalization": True,
                    "conversationContext": {},
                },
                call_id=call_id,
                parent_request_id=parent_request_id,
                deadline_at=deadline_at,
            )
        except asyncio.CancelledError:
            await self.automation.cancel(call_id)
            raise
        except Exception as error:
            error_code = str(getattr(error, "code", ""))
            if on_progress:
                await on_progress("finalizing", {
                    "type": "model_completed", "stage": "finalization", "status": "failed",
                    "callId": call_id, "displayName": "反馈生成失败",
                    "elapsedMs": round((time.monotonic() - started_at) * 1000),
                    "errorCode": error_code or "MODEL_SUMMARY_FAILED",
                })
            if error_code.upper() in {"UPSTREAM_TIMEOUT", "PROVIDER_TIMEOUT"}:
                message = f"已读取 {len(snapshot.chapters)}/{len(snapshot.chapters)} 章，但模型总结再次超时。"
                return AgentChatResponse(
                    conversationId=snapshot.conversationId,
                    assistantMessage=AgentMessage(role="assistant", content=message),
                    status="failed",
                    failure={
                        "code": "MODEL_SUMMARY_TIMEOUT", "message": message, "retryable": True,
                        "coverage": {"completed": len(snapshot.chapters), "total": len(snapshot.chapters)},
                    },
                    evidenceSnapshotId=snapshot_id,
                    contextReads=snapshot.contextReads,
                )
            raise
        finally:
            self._unregister_chat_call(parent_request_id, call_id)
        content = str(result.get("content") or "").strip() if isinstance(result, dict) else ""
        if not content:
            raise ValueError("Summary retry returned an invalid response")
        assistant = AgentMessage(role="assistant", content=content)
        self.state.conversations.setdefault(snapshot.conversationId, []).append(assistant)
        self._save()
        if on_progress:
            await on_progress("finalizing", {
                "type": "model_completed", "stage": "finalization", "status": "completed",
                "callId": call_id, "displayName": "反馈生成完成",
                "elapsedMs": round((time.monotonic() - started_at) * 1000),
            })
        return AgentChatResponse(
            conversationId=snapshot.conversationId,
            assistantMessage=assistant,
            status="completed",
            evidenceSnapshotId=snapshot_id,
            contextReads=snapshot.contextReads,
        )

    def delete_chat_context(self, params: dict[str, Any]) -> dict[str, Any]:
        conversation_id = str(params.get("conversationId") or "").strip()
        storage_conversation_id = str(params.get("storageConversationId") or "").strip()
        if not conversation_id:
            raise ValueError("conversationId is required")
        self.state.conversations.pop(conversation_id, None)
        self.state.pendingClarifications.pop(conversation_id, None)
        self.state.intentDecisions.pop(conversation_id, None)
        for request_key, pending in list(self.state.pendingUserInputs.items()):
            if pending.get("conversationId") == conversation_id:
                self.state.pendingUserInputs.pop(request_key, None)
        removed_snapshots = 0
        for snapshot_id, snapshot in list(self.state.evidenceSnapshots.items()):
            if snapshot.conversationId == conversation_id:
                self.state.evidenceSnapshots.pop(snapshot_id, None)
                removed_snapshots += 1
        for recovery_ref, recovery in list(self.state.recoveryRecords.items()):
            if (
                recovery.get("kind") == "chat_model_output"
                and (
                    str(recovery.get("conversationId") or "") == conversation_id
                    or bool(storage_conversation_id) and str(recovery.get("storageConversationId") or "") == storage_conversation_id
                )
            ):
                self.state.recoveryRecords.pop(recovery_ref, None)
        self._save()
        return {"ok": True, "conversationId": conversation_id, "removedEvidenceSnapshots": removed_snapshots}

    async def cancel_chat_request(self, request_id: str) -> bool:
        """Cancel the currently active upstream model or read-tool request for a chat."""
        cancelled = False
        call_ids = list(self._active_chat_call_ids.get(request_id) or set())
        for call_id in call_ids:
            for target in (self.automation, self.tool_adapter):
                try:
                    cancelled = await target.cancel(call_id) or cancelled
                except Exception:
                    # A call has exactly one upstream owner; the other transport can report missing.
                    continue
        self._active_chat_call_ids.pop(request_id, None)
        return cancelled

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
        # Toolchain nodes can fail after request-level retry handling (for
        # example, a truncated synthesis). Their terminal event is retryable
        # even when no request_retry_exhausted event was emitted.
        if not (
            (exhausted is not None and exhausted.payload.get("retryable") is True)
            or (terminal is not None and terminal.payload.get("retryable") is True)
        ):
            return None
        return FailedRunRef(
            runId=failed_run.runId,
            failureRevision=failed_run.failureRevision,
            retryable=True,
            code=str((exhausted.payload.get("code") if exhausted else None) or terminal_code) or None,
        )

    def _latest_retryable_failed_run_ref(
        self,
        active_run_id: str | None,
        prior_runs: Any,
    ) -> FailedRunRef | None:
        active_failed_run = self._retryable_failed_run_ref(active_run_id)
        if active_failed_run is not None:
            return active_failed_run
        if not isinstance(prior_runs, list):
            return None
        seen_run_ids = {active_run_id} if active_run_id else set()
        for run_ref in prior_runs:
            if not isinstance(run_ref, dict):
                continue
            run_id = run_ref.get("runId")
            if not run_id:
                continue
            normalized_run_id = str(run_id)
            if normalized_run_id in seen_run_ids:
                continue
            seen_run_ids.add(normalized_run_id)
            failed_run = self._retryable_failed_run_ref(normalized_run_id)
            if failed_run is not None:
                return failed_run
        return None

    async def _invoke_exploration_tool(
        self,
        tool_name: str,
        tool_args: dict[str, Any],
        message: str,
        context: dict[str, str],
        locale: str,
        request_id: str | None = None,
        parent_request_id: str | None = None,
        deadline_at: str | None = None,
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
            if "offset" in tool_args:
                params["offset"] = max(0, int(tool_args["offset"]))
            if "limit" in tool_args:
                params["limit"] = max(1, min(200, int(tool_args["limit"])))
            params["includeContent"] = bool(tool_args["includeContent"]) if "includeContent" in tool_args else False
        elif tool_name == "chapter.get":
            requested_chapter_id = str(tool_args.get("chapterId") or chapter_id).strip()
            if not requested_chapter_id or requested_chapter_id.upper() in {"ALL", "ALL_IF_SUPPORTED"}:
                raise ValueError("chapterId is required for chapter.get")
            params = {"chapterId": requested_chapter_id}
        elif tool_name == "chapter.scope_context.build":
            authoritative = ChapterScopeContextInput.model_validate({
                **tool_args,
                "novelId": novel_id,
                "goal": str(tool_args.get("goal") or message),
                "locale": locale,
            })
            params = authoritative.model_dump(exclude_none=True)
        elif tool_name == "attachment.list":
            conversation_id = context.get("agentConversationId") or ""
            if not novel_id or not conversation_id:
                raise ValueError("novelId and conversationId are required for attachment.list")
            params = {"novelId": novel_id, "conversationId": conversation_id}
        elif tool_name == "attachment.search":
            conversation_id = context.get("agentConversationId") or ""
            query = str(tool_args.get("query") or "").strip()
            if not novel_id or not conversation_id or not query:
                raise ValueError("novelId, conversationId and query are required for attachment.search")
            params = {
                "novelId": novel_id,
                "conversationId": conversation_id,
                "query": query[:200],
                "limit": max(1, min(20, int(tool_args.get("limit") or 10))),
            }
            attachment_id = str(tool_args.get("attachmentId") or "").strip()
            if attachment_id:
                params["attachmentId"] = attachment_id
        elif tool_name in {"attachment.get", "attachment.read", "attachment.outline"}:
            conversation_id = context.get("agentConversationId") or ""
            attachment_id = str(tool_args.get("attachmentId") or "").strip()
            if not novel_id or not conversation_id or not attachment_id:
                raise ValueError(f"novelId, conversationId and attachmentId are required for {tool_name}")
            params = {
                "novelId": novel_id,
                "conversationId": conversation_id,
                "attachmentId": attachment_id,
            }
            if tool_name == "attachment.get":
                has_alias_range = tool_args.get("startOffset") is not None or tool_args.get("endOffset") is not None
                if has_alias_range:
                    start_offset = int(tool_args.get("startOffset") or 0)
                    end_offset = int(tool_args.get("endOffset")) if tool_args.get("endOffset") is not None else start_offset + 12000
                    if start_offset < 0 or end_offset < start_offset:
                        raise ValueError("attachment.get requires 0 <= startOffset <= endOffset")
                    params["offset"] = start_offset
                    params["limit"] = max(1, min(12000, end_offset - start_offset))
                else:
                    params["offset"] = max(0, int(tool_args.get("offset") or 0))
                    params["limit"] = max(1, min(12000, int(tool_args.get("limit") or 12000)))
            elif tool_name == "attachment.read":
                selector = tool_args.get("selector")
                if not isinstance(selector, dict):
                    raise ValueError("selector is required for attachment.read")
                params["selector"] = selector
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
        return await self.tool_adapter.invoke(
            tool_name,
            params,
            "desktop-ui",
            request_id=request_id,
            parent_request_id=parent_request_id,
            deadline_at=deadline_at,
        )

    async def plan(self, params: dict[str, Any], context: dict[str, Any]) -> AgentPlan:
        goal = str(params.get("goal") or params.get("message") or "")
        if not goal.strip():
            raise ValueError("goal is required")
        intent_payload = params.get("intentDecision")
        if not isinstance(intent_payload, dict):
            conversation_id = str(params.get("conversationId") or "").strip()
            stored_intent = self.state.intentDecisions.get(conversation_id) if conversation_id else None
            if isinstance(stored_intent, dict):
                intent_payload = stored_intent
        intent_decision = IntentDecision.model_validate(intent_payload) if isinstance(intent_payload, dict) else None
        editor_selection = params.get("editorSelection")
        if not isinstance(editor_selection, dict):
            editor_selection = context.get("editorSelection") if isinstance(context.get("editorSelection"), dict) else {}
        editor_chapter_id = str(
            editor_selection.get("chapterId") or params.get("chapterId") or context.get("chapterId") or ""
        ).strip()
        editor_volume_id = str(
            editor_selection.get("volumeId") or params.get("volumeId") or context.get("volumeId") or ""
        ).strip()
        authoritative_intent_ref = next((
            operation.target
            for operation in (intent_decision.operations if intent_decision else [])
            if operation.target.kind in {"chapter", "chapter_scope"}
            and operation.target.source == "explicit_id"
            and (operation.target.id or operation.target.ids)
        ), None)
        target_resolution_text = goal.split("\n\n会话背景（仅用于理解当前任务）：\n", 1)[0].strip() or goal
        request_target = (
            ResolvedIntentTarget(
                selector=str(authoritative_intent_ref.selector or "explicit_chapter_id"),
                chapterId=authoritative_intent_ref.id or authoritative_intent_ref.ids[0],
                chapterIds=authoritative_intent_ref.ids,
                volumeId=authoritative_intent_ref.volumeId,
                title=authoritative_intent_ref.title,
                label=authoritative_intent_ref.label,
                wordCount=authoritative_intent_ref.wordCount,
                hasContent=authoritative_intent_ref.hasContent,
                source="user_message",
            )
            if authoritative_intent_ref
            else resolve_intent_chapter_target(
                target_resolution_text,
                params.get("chapterCatalog") or context.get("chapterCatalog"),
                editor_chapter_id=editor_chapter_id or None,
                editor_volume_id=editor_volume_id or None,
            )
        )
        if (
            request_target
            and request_target.source in {"user_message", "structured_selection"}
            and not request_target.chapterId
        ):
            novel_id = str(params.get("novelId") or context.get("novelId") or "").strip()
            if novel_id:
                try:
                    hydrated_catalog = await self.tool_adapter.invoke(
                        "volume.list",
                        {"novelId": novel_id},
                        "desktop-ui",
                    )
                    hydrated_target = resolve_intent_chapter_target(
                        target_resolution_text,
                        hydrated_catalog,
                        editor_chapter_id=editor_chapter_id or None,
                        editor_volume_id=editor_volume_id or None,
                    )
                    if hydrated_target and hydrated_target.chapterId:
                        request_target = hydrated_target
                except Exception:
                    # The renderer catalog remains a valid best-effort source.
                    # If it was incomplete, the guarded unresolved-target path
                    # below returns a user-actionable planning error.
                    pass
        unresolved_explicit_target = bool(
            request_target
            and request_target.source in {"user_message", "structured_selection"}
            and not request_target.chapterId
        )
        if unresolved_explicit_target:
            requested_operation_ids = (
                [operation.type for operation in intent_decision.operations]
                if intent_decision
                else detect_explicit_operations(goal)
            )
            if any(
                (definition := INTENT_OPERATION_REGISTRY.get(operation_id)) is not None
                and definition.targetKind in {"chapter", "chapter_scope"}
                and definition.requestedEffect == "draft_write"
                for operation_id in requested_operation_ids
            ):
                raise AgentRequestError(AgentRequestFailure(
                    code="CHAPTER_TARGET_UNRESOLVED",
                    retryable=False,
                    attempts=1,
                    user_message="暂时无法确定目标章节。请刷新章节目录后直接重试生成计划。",
                    diagnostic_ref=new_id("diagnostic"),
                    details={"recoveryAction": "refresh_catalog_and_retry_plan"},
                ))
        if intent_decision and request_target and request_target.chapterId:
            resolved_ref = IntentTargetRef(
                kind="chapter",
                source=(
                    "explicit_id"
                    if request_target.source in {"user_message", "structured_selection"}
                    else "current_selection"
                ),
                id=request_target.chapterId,
                ids=request_target.chapterIds,
                selector=request_target.selector,
                volumeId=request_target.volumeId,
                title=request_target.title,
                label=request_target.label,
                wordCount=request_target.wordCount,
                hasContent=request_target.hasContent,
            )
            intent_decision = intent_decision.model_copy(update={
                "operations": [
                    operation.model_copy(update={"target": resolved_ref})
                    if operation.target.kind == "chapter"
                    else operation
                    for operation in intent_decision.operations
                ],
            })
        user_decisions = params.get("userDecisions") if isinstance(params.get("userDecisions"), dict) else None
        plan_goal = goal
        if user_decisions:
            summary = str(user_decisions.get("understandingSummary") or "").strip()
            if summary:
                plan_goal = f"{goal}\n\n用户已确认决策：{summary}"
        preferred_role = str(params.get("role") or "team")
        explicit_scope = self._explicit_chapter_scope(params, context, goal=plan_goal)
        has_chapter = bool(
            params.get("chapterId")
            or context.get("chapterId")
            or (explicit_scope and (explicit_scope.get("chapterId") or explicit_scope.get("chapterIds")))
            or (
                intent_decision
                and any(operation.target.id for operation in intent_decision.operations if operation.target.kind == "chapter")
            )
        )
        plan = build_plan_from_intent(
            plan_goal,
            intent_decision,
            preferred_role=preferred_role,
            has_chapter=has_chapter,
        )
        if plan is None:
            result = await self._retryable_automation_invoke(
                None,
                "agent.generate_plan",
                {
                    "goal": goal,
                    "role": preferred_role,
                    "locale": str(params.get("locale") or context.get("locale") or "zh-CN"),
                    "availableTools": AVAILABLE_AGENT_TOOLS,
                    "availableToolchains": TOOLCHAIN_REGISTRY.list_for_planning(),
                    "intentDecision": intent_decision.model_dump() if intent_decision else None,
                    "userDecisions": user_decisions,
                },
            )
            plan = build_plan_from_model(plan_goal, result, preferred_role)
            plan = route_plan_from_intent(
                plan,
                intent_decision,
                has_chapter=has_chapter,
            )
        if user_decisions:
            plan = plan.model_copy(update={"userDecisions": user_decisions})
        plan = self._apply_explicit_chapter_scope(plan, params, context)
        plan = self._apply_resolved_operation_targets(plan, intent_decision)
        plan = self._apply_fallback_resolved_target(plan, request_target)
        plan = self._apply_novel_project_initialization_source(plan, params)
        plan = self._apply_agent_skills_to_plan(
            plan,
            intent_decision,
            locale=str(params.get("locale") or context.get("locale") or "zh-CN"),
            novel_id=str(params.get("novelId") or context.get("novelId") or "").strip() or None,
        )
        # A novel bootstrap is read-only until the user accepts its resulting
        # project blueprint, but it still represents a high-impact creative
        # commitment. Keep its execution visible and explicitly confirmed.
        requires_bootstrap_confirmation = any(
            step.toolchain and step.toolchain.id == "novel.bootstrap"
            for step in plan.steps
        )
        requires_project_initialization_confirmation = any(
            step.toolchain and step.toolchain.id == "novel.project_initialize"
            for step in plan.steps
        )
        plan = plan.model_copy(update={
            "requestedEffect": infer_plan_effect(plan),
            "requiresApproval": (
                requires_bootstrap_confirmation
                or requires_project_initialization_confirmation
                or not self._qualifies_for_policy_approval(plan, params, context)
            ),
        })
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
        if any(run.planId == plan_id and run.status in {"running", "cancelling", "waiting_approval", "waiting_user_input"} for run in self.state.runs.values()):
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
                "availableToolchains": TOOLCHAIN_REGISTRY.list_for_planning(),
                "currentPlan": plan.model_dump(),
            },
        )
        revised = revise_plan_from_model(plan, result, revision=revision)
        revised = self._apply_explicit_chapter_scope(revised, params, context)
        revised = self._preserve_resolved_operation_targets(plan, revised)
        revision_target = resolve_intent_chapter_target(
            revision,
            params.get("chapterCatalog") or context.get("chapterCatalog"),
        )
        if revision_target and revision_target.source in {"user_message", "structured_selection"}:
            if not revision_target.chapterId:
                raise AgentRequestError(AgentRequestFailure(
                    code="CHAPTER_TARGET_UNRESOLVED",
                    retryable=False,
                    attempts=1,
                    user_message="暂时无法确定修订意见中的目标章节。请刷新章节目录后直接重试修订计划。",
                    diagnostic_ref=new_id("diagnostic"),
                    details={"recoveryAction": "refresh_catalog_and_retry_plan"},
                ))
            revised = self._apply_fallback_resolved_target(revised, revision_target)
        revised = revised.model_copy(update={
            "requiresApproval": not self._qualifies_for_policy_approval(revised, params, context),
        })
        self.state.plans[plan_id] = revised
        self._save()
        return revised

    @staticmethod
    def _run_deadline_at(
        plan: AgentPlan,
        params: dict[str, Any],
        context: dict[str, Any],
        *,
        step_ids: set[str] | None = None,
    ) -> str:
        explicit = str(params.get("deadlineAt") or context.get("deadlineAt") or "").strip()
        if explicit:
            try:
                parsed = datetime.fromisoformat(explicit.replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError("deadlineAt must be an ISO-8601 timestamp") from error
            if parsed.tzinfo is None:
                raise ValueError("deadlineAt must include a timezone")
            return parsed.astimezone(timezone.utc).isoformat()
        toolchain_timeout_seconds = 0
        for step in plan.steps:
            if step_ids is not None and step.stepId not in step_ids:
                continue
            if step.toolchain is None:
                continue
            definition = TOOLCHAIN_REGISTRY.resolve(step.toolchain.id, step.toolchain.version)
            toolchain_timeout_seconds += definition.budget.timeoutSeconds
        timeout_seconds = toolchain_timeout_seconds or 600
        return (datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)).isoformat()

    @staticmethod
    def _earliest_deadline(*values: str | None) -> str | None:
        parsed: list[tuple[datetime, str]] = []
        for value in values:
            normalized = str(value or "").strip()
            if not normalized:
                continue
            try:
                deadline = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
            except ValueError:
                continue
            if deadline.tzinfo is None:
                continue
            parsed.append((deadline, normalized))
        return min(parsed, key=lambda item: item[0])[1] if parsed else None

    @staticmethod
    def _seconds_until_deadline(value: str | None) -> float | None:
        normalized = str(value or "").strip()
        if not normalized:
            return None
        try:
            deadline = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError:
            return None
        if deadline.tzinfo is None:
            return None
        return (deadline - datetime.now(timezone.utc)).total_seconds()

    async def execute_plan(self, params: dict[str, Any], context: dict[str, Any]) -> AgentRun:
        plan_id = str(params.get("planId") or "")
        plan = self.state.plans.get(plan_id)
        if not plan:
            raise ValueError("planId not found")
        validate_plan_effect(plan)

        approval = params.get("approval")
        if plan.requiresApproval:
            if not isinstance(approval, dict) or approval.get("approved") is not True:
                raise ValueError("Explicit plan approval is required")
            requested_step_ids = approval.get("approvedStepIds")
            if not isinstance(requested_step_ids, list) or not requested_step_ids:
                raise ValueError("approvedStepIds must contain at least one step")
            approved_step_ids = {str(step_id) for step_id in requested_step_ids}
            approval_source = "user"
        else:
            if not self._qualifies_for_policy_approval(plan, params, context):
                raise ValueError("Plan no longer satisfies automatic approval policy")
            approved_step_ids = {step.stepId for step in plan.steps}
            approval_source = "policy"
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

        skill_snapshot = []
        seen_skill_revisions: set[tuple[str, str]] = set()
        for step in plan.steps:
            if step.stepId not in approved_step_ids:
                continue
            for skill in step.skills:
                key = (skill.skillId, skill.revisionId)
                if key in seen_skill_revisions:
                    continue
                seen_skill_revisions.add(key)
                skill_snapshot.append(skill.model_copy(deep=True))

        run = AgentRun(
            runId=new_id("run"),
            threadId=plan.threadId,
            planId=plan.planId,
            status="running",
            deadlineAt=self._run_deadline_at(plan, params, context, step_ids=approved_step_ids),
            skillSnapshot=skill_snapshot,
            userInputResponses=[plan.userDecisions] if plan.userDecisions else [],
        )
        self.state.runs[run.runId] = run
        for step in plan.steps:
            step.status = "pending" if step.stepId in approved_step_ids else "skipped"

        novel_id = str(params.get("novelId") or context.get("novelId") or "")
        volume_id = params.get("volumeId") or context.get("volumeId")
        chapter_id = params.get("chapterId") or context.get("chapterId")
        current_content = str(params.get("currentContent") or "")
        locale = str(params.get("locale") or context.get("locale") or "zh-CN")
        await self._emit(run, "run_started", payload={
            "planId": plan.planId,
            "title": plan.title,
            "skills": [skill.model_dump() for skill in run.skillSnapshot],
        })
        await self._emit(run, "plan_approved", payload={
            "approvedStepIds": sorted(approved_step_ids),
            "approvalSource": approval_source,
        })
        execution_state = ExecutionState(
            run_id=run.runId,
            approved_step_ids=sorted(approved_step_ids),
            approval_mode=str(params.get("approvalMode") or "review_required"),
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
            pending_operation=None,
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
        self._refresh_local_recovery_capability(failed_run)
        expected_revision = params.get("expectedFailureRevision")
        if not isinstance(expected_revision, int) or expected_revision < 1:
            raise ValueError("expectedFailureRevision must be a positive integer")
        if failed_run.failureRevision != expected_revision:
            raise ValueError("Failed run revision conflict")
        mode = str(params.get("mode") or "failed_node")
        strategy = str(params.get("strategy") or (
            failed_run.recovery.retryStrategy if failed_run.recovery else "retry_request"
        ))
        allowed_strategies = {"retry_request", "repair_model_output", "reprocess_saved_result"}
        if strategy not in allowed_strategies:
            raise ValueError(f"Unsupported recovery strategy: {strategy}")
        if failed_run.recovery and strategy != failed_run.recovery.retryStrategy:
            raise ValueError("Recovery strategy conflict")
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
        retry_after_repair_exhausted = bool(
            failed_run.recovery
            and failed_run.recovery.failureKind == "model_output_invalid"
            and failed_run.recovery.blockedReason == "repair_exhausted"
        )
        review_recovery = self.state.recoveryRecords.get(failed_run.runId) or {}
        retry_saved_draft_review = bool(
            failed_run.recovery and failed_run.recovery.canRecover
            and review_recovery.get("nodeId") == "draft.editorial_review"
            and review_recovery.get("sourceMethod") == "agent.generate_consistency_review"
            and review_recovery.get("draftSessionId") == failed_run.draftSessionId
        )
        if (
            strategy == "retry_request"
            and not retry_after_repair_exhausted
            and not retry_saved_draft_review
            and not (
                (exhausted is not None and exhausted.payload.get("retryable") is True)
                or (terminal is not None and terminal.payload.get("retryable") is True)
            )
        ):
            raise ValueError("The failed run has no retryable failure")

        checkpoint_state = self.execution_graph.load_checkpoint_state(f"run:{failed_run.runId}")
        if checkpoint_state is None:
            raise ValueError("Failed run checkpoint is unavailable")
        plan = self.state.plans.get(failed_run.planId)
        if plan is None:
            raise ValueError("Failed run plan is unavailable")

        retry_attempt = failed_run.retryAttempt + 1
        retry_root_run_id = failed_run.retryRootRunId or failed_run.retryOfRunId or failed_run.runId
        recovery_record = self.state.recoveryRecords.get(failed_run.runId) or {}
        resumed_from = {
            "phase": checkpoint_state.get("phase"),
            "stepIndex": checkpoint_state.get("step_index"),
            "toolIndex": checkpoint_state.get("tool_index"),
            "stepId": failed_run.currentStepId,
            "nodeId": recovery_record.get("nodeId") or (exhausted.payload.get("nodeId") if exhausted else None),
            "method": recovery_record.get("sourceMethod") or (exhausted.payload.get("method") if exhausted else None),
            "diagnosticRef": recovery_record.get("diagnosticRef") or (exhausted.payload.get("diagnosticRef") if exhausted else None),
            "strategy": strategy,
        }
        repaired_payload: Any | None = None
        if strategy == "repair_model_output":
            if not recovery_record or not recovery_record.get("modelResultRef"):
                raise ValueError("Saved model result is unavailable for repair")
            try:
                repaired_payload = await self._repair_saved_structured_output(
                    None,
                    source_method=str(recovery_record.get("sourceMethod") or ""),
                    node_id=str(recovery_record.get("nodeId") or "model"),
                    details=recovery_record,
                    repair_attempt=2,
                )
            except Exception as repair_error:
                if isinstance(repair_error, AgentRequestError) and repair_error.code == "MODEL_REPAIR_IN_PROGRESS":
                    raise
                failed_run.failureRevision += 1
                failed_run.recovery = failed_run.recovery.model_copy(update={
                    "retryStrategy": "retry_request",
                    "actionLabel": "重新请求模型",
                    "recoveryRevision": failed_run.failureRevision,
                    "blockedReason": "repair_exhausted",
                }) if failed_run.recovery else None
                self._save()
                raise
        elif strategy == "reprocess_saved_result":
            if not recovery_record or not recovery_record.get("modelResultRef"):
                raise ValueError("Saved model result is unavailable for local reprocessing")
            try:
                repaired_payload = await self._reprocess_saved_structured_output(
                    source_method=str(recovery_record.get("sourceMethod") or ""),
                    node_id=str(recovery_record.get("nodeId") or "model"),
                    details=recovery_record,
                )
            except Exception as reprocess_error:
                failed_run.failureRevision += 1
                recovery_record["processorVersion"] = self._STRUCTURED_OUTPUT_PROCESSOR_VERSION
                recovery_record["failureFingerprint"] = hashlib.sha256(
                    f"{type(reprocess_error).__name__}|{reprocess_error}".encode("utf-8")
                ).hexdigest()
                failed_run.recovery = failed_run.recovery.model_copy(update={
                    "retryStrategy": "none",
                    "canRecover": False,
                    "actionLabel": None,
                    "recoveryRevision": failed_run.failureRevision,
                    "blockedReason": "processor_update_required",
                }) if failed_run.recovery else None
                self._save()
                raise
        retry_run = AgentRun(
            runId=new_id("run"),
            threadId=failed_run.threadId,
            planId=failed_run.planId,
            status="running",
            deadlineAt=self._run_deadline_at(plan, {}, {}),
            currentStepId=failed_run.currentStepId,
            progress=failed_run.progress,
            artifacts=[artifact.model_copy(deep=True) for artifact in failed_run.artifacts],
            skillSnapshot=[skill.model_copy(deep=True) for skill in failed_run.skillSnapshot],
            draftSessionId=failed_run.draftSessionId,
            draftBatchId=failed_run.draftBatchId,
            approvalResponses=[dict(response) for response in failed_run.approvalResponses],
            retryOfRunId=failed_run.runId,
            retryRootRunId=retry_root_run_id,
            retryAttempt=retry_attempt,
            resumedFrom=resumed_from,
        )
        self.state.runs[retry_run.runId] = retry_run
        if repaired_payload is not None:
            recovery_node_id = str(recovery_record.get("nodeId") or recovery_record.get("sourceMethod") or "")
            self.state.pendingModelResults[f"{retry_run.runId}:{recovery_node_id}"] = {
                "payload": repaired_payload,
                "modelResultRef": recovery_record.get("modelResultRef"),
                "repairAttempt": (
                    2 if strategy == "repair_model_output"
                    else int(recovery_record.get("automaticRepairAttempts") or 0)
                ),
            }

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
            "pending_operation": None,
        })
        await self._emit(
            retry_run,
            "run_started",
            payload={
                "planId": plan.planId,
                "title": plan.title,
                "retryOfRunId": failed_run.runId,
                "retryAttempt": retry_attempt,
                "skills": [skill.model_dump() for skill in retry_run.skillSnapshot],
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
                "strategy": strategy,
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
            and run.status in {"running", "waiting_approval", "waiting_user_input", "cancelling"}
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
            deadlineAt=self._run_deadline_at(plan, params, context),
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
            and run.status in {"running", "waiting_approval", "waiting_user_input", "cancelling"}
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
            deadlineAt=self._run_deadline_at(plan, params, context),
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
            approval_mode=str(params.get("approvalMode") or "full_control"),
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
            pending_operation=None,
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

    def _schedule_draft_operation_watcher(
        self,
        run_id: str,
        pending_operation: dict[str, Any],
        *,
        delay_seconds: float = 0,
    ) -> None:
        active_task = self._run_tasks.get(run_id)
        if active_task is not None and not active_task.done():
            return
        existing_timer = self._operation_watch_timers.pop(run_id, None)
        if existing_timer is not None:
            existing_timer.cancel()

        def launch() -> None:
            self._operation_watch_timers.pop(run_id, None)
            active = self._run_tasks.get(run_id)
            if active is not None and not active.done():
                return
            task = asyncio.create_task(
                self._watch_draft_operation(run_id, dict(pending_operation))
            )
            self._operation_watch_tasks[run_id] = task
            self._run_tasks[run_id] = task

        if delay_seconds <= 0:
            launch()
            return
        self._operation_watch_timers[run_id] = asyncio.get_running_loop().call_later(
            delay_seconds,
            launch,
        )

    async def _watch_draft_operation(
        self,
        run_id: str,
        pending_operation: dict[str, Any],
    ) -> None:
        operation_id = str(pending_operation.get("operationId") or "").strip()
        operation_key = str(pending_operation.get("operationKey") or "").strip()
        poll_after_seconds = max(
            0.25,
            min(5.0, float(pending_operation.get("pollAfterSeconds") or 1.0)),
        )
        current_task = asyncio.current_task()
        reschedule: dict[str, Any] | None = None
        try:
            if not operation_id or not operation_key:
                raise DraftOperationFailed(
                    "INVALID_OPERATION_CHECKPOINT",
                    "后台草稿任务的恢复检查点无效。",
                    operation_id or operation_key,
                )
            run = self.state.runs.get(run_id)
            if run is None or run.status in {"completed", "failed", "cancelled"}:
                return
            if run.draftOperationId and run.draftOperationId != operation_id:
                raise DraftOperationFailed(
                    "OPERATION_CHECKPOINT_MISMATCH",
                    "后台草稿任务与 Agent 检查点不一致。",
                    operation_id,
                )
            if run.cancelRequested or run.status == "cancelling":
                await self._cancel_draft_operation(operation_id)
                await self._finish_run(
                    run,
                    "cancelled",
                    "run_cancelled",
                    {"reason": "User cancelled durable draft operation", "operationId": operation_id},
                )
                return
            try:
                observed = await self._get_draft_operation_status(run, operation_id)
            except AgentRequestError:
                # Leave the graph interrupted and schedule a fresh bounded
                # observation. No long-lived LangGraph or polling task remains.
                poll_after_seconds = max(1.0, poll_after_seconds)
                reschedule = dict(pending_operation)
            else:
                operation_status, operation_version = await self._record_draft_operation_progress(
                    run,
                    operation_id,
                    observed,
                )
                if operation_status in {
                    "succeeded",
                    "cancelled",
                    "reconcile_required",
                    "definitive_failed",
                }:
                    await self._run_graph_guarded(
                        run_id,
                        resume={
                            "operationId": operation_id,
                            "operationKey": operation_key,
                            "operationStatus": operation_status,
                            "operationVersion": operation_version,
                        },
                    )
                    return
                poll_after_ms = observed.get("pollAfterMs")
                if isinstance(poll_after_ms, (int, float)):
                    poll_after_seconds = max(0.25, min(5.0, float(poll_after_ms) / 1000))
                reschedule = {
                    "operationId": operation_id,
                    "operationKey": operation_key,
                    "operationStatus": operation_status,
                    "operationVersion": operation_version,
                    "pollAfterSeconds": poll_after_seconds,
                }
        except asyncio.CancelledError:
            run = self.state.runs.get(run_id)
            if run and run.status not in {"completed", "failed", "cancelled"}:
                try:
                    await asyncio.shield(self._cancel_draft_operation(operation_id))
                except Exception:
                    pass
                await asyncio.shield(
                    self._finish_run(
                        run,
                        "cancelled",
                        "run_cancelled",
                        {"reason": "User cancelled durable draft operation", "operationId": operation_id},
                    )
                )
        except Exception as error:
            run = self.state.runs.get(run_id)
            if run and run.status not in {"completed", "failed", "cancelled"}:
                self._classify_local_transform_failure(run, error)
                code = getattr(error, "code", None)
                public_message = self._public_failure_message(run, error)
                payload = {
                    "message": str(error),
                    "stage": "draft_operation_watch",
                    "code": code,
                    "operationId": operation_id,
                }
                await self._emit(run, "error", payload=payload)
                await self._finish_run(run, "failed", "run_failed", payload)
        finally:
            if self._operation_watch_tasks.get(run_id) is current_task:
                self._operation_watch_tasks.pop(run_id, None)
            if self._run_tasks.get(run_id) is current_task:
                self._run_tasks.pop(run_id, None)
        if reschedule is not None:
            run = self.state.runs.get(run_id)
            if run and run.status in {"running", "cancelling"}:
                self._schedule_draft_operation_watcher(
                    run_id,
                    reschedule,
                    delay_seconds=poll_after_seconds,
                )

    async def operation_completed(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle an advisory outbox wakeup; status is always re-read from Electron."""
        operation_id = str(params.get("operationId") or "").strip()
        if not operation_id:
            raise ValueError("operationId is required")
        awakened_run_ids: list[str] = []
        for run in self.state.runs.values():
            if (
                run.draftOperationId != operation_id
                or run.status not in {"running", "cancelling"}
                or not run.draftOperationKey
            ):
                continue
            awakened_run_ids.append(run.runId)
            timer = self._operation_watch_timers.pop(run.runId, None)
            if timer is not None:
                timer.cancel()
            self._schedule_draft_operation_watcher(
                run.runId,
                {
                    "operationId": operation_id,
                    "operationKey": run.draftOperationKey,
                    "operationStatus": str(params.get("status") or run.draftOperationStatus or "queued"),
                    "operationVersion": int(params.get("version") or run.draftOperationVersion or 1),
                    "pollAfterSeconds": 0.25,
                },
            )
        return {
            "operationId": operation_id,
            "accepted": True,
            "awakenedRunIds": awakened_run_ids,
        }

    async def _cancel_draft_operation(self, operation_id: str) -> None:
        if not operation_id:
            return
        await self.tool_adapter.invoke(
            "chapter.draft.cancel",
            {"operationId": operation_id},
            "desktop-ui",
            request_id=new_id("automation"),
        )

    async def _run_graph_guarded(
        self,
        run_id: str,
        *,
        initial_state: ExecutionState | None = None,
        resume: dict[str, Any] | None = None,
    ) -> None:
        pending_operation: dict[str, Any] | None = None
        try:
            run = self.state.runs.get(run_id)
            remaining_seconds = self._seconds_until_deadline(run.deadlineAt if run else None)
            if remaining_seconds is None:
                result = await self.execution_graph.run(
                    f"run:{run_id}",
                    self._advance_execution,
                    initial_state=initial_state,
                    resume=resume,
                )
            else:
                # The adapter/provider layers receive the exact deadline. This
                # outer guard adds only transport/checkpoint cleanup grace and
                # catches stalls before a request reaches those layers.
                async with asyncio.timeout(max(0.1, remaining_seconds + 1.0)):
                    result = await self.execution_graph.run(
                        f"run:{run_id}",
                        self._advance_execution,
                        initial_state=initial_state,
                        resume=resume,
                    )
            candidate = result.get("pending_operation")
            if result.get("action") == "waiting_operation" and isinstance(candidate, dict):
                pending_operation = dict(candidate)
        except asyncio.CancelledError:
            run = self.state.runs.get(run_id)
            if run and run.status not in {"completed", "failed", "cancelled"}:
                await asyncio.shield(
                    self._finish_run(run, "cancelled", "run_cancelled", {"reason": "User cancelled active request"})
                )
        except Exception as error:
            run = self.state.runs.get(run_id)
            if run and run.status not in {"completed", "failed", "cancelled"}:
                if isinstance(error, TimeoutError):
                    code = "UPSTREAM_TIMEOUT"
                    public_message = "任务超过允许的总处理时间，已停止执行。"
                    details = {"retryable": True, "deadlineAt": run.deadlineAt}
                else:
                    public_message = self._public_failure_message(run, error)
                    code = getattr(error, "code", None)
                    details = error.failure.payload() if isinstance(error, AgentRequestError) else (
                        error.payload() if isinstance(error, ToolchainError) else {}
                    )
                recovery_payload = error.details.get("recovery") if isinstance(error, ToolchainError) else None
                if isinstance(recovery_payload, dict):
                    run.recovery = AgentRecoveryDescriptor.model_validate(recovery_payload)
                failure_payload = {**details, "message": public_message, "stage": "execution_graph", "code": code}
                plan = self.state.plans.get(run.planId)
                step = next(
                    (item for item in (plan.steps if plan else []) if item.stepId == run.currentStepId),
                    None,
                )
                if step is not None and step.status not in {"completed", "failed", "skipped"}:
                    active_tool_call = next(
                        (
                            event for event in reversed(run.events)
                            if event.type == "tool_call" and event.stepId == step.stepId and event.status == "running"
                        ),
                        None,
                    )
                    if active_tool_call is not None:
                        has_later_result = any(
                            event.type == "tool_result"
                            and event.stepId == step.stepId
                            and event.toolName == active_tool_call.toolName
                            and event.sequence > active_tool_call.sequence
                            for event in run.events
                        )
                        if not has_later_result:
                            await self._emit(
                                run,
                                "tool_result",
                                step_id=step.stepId,
                                agent=step.agent,
                                tool_name=active_tool_call.toolName,
                                status="failed",
                                payload={
                                    "summary": public_message,
                                    "code": code,
                                    "retryable": bool(details.get("retryable")),
                                    "transport": self.tool_transport,
                                    **{
                                        key: active_tool_call.payload[key]
                                        for key in ("toolchainId", "nodeId")
                                        if key in active_tool_call.payload
                                    },
                                },
                            )
                    if step.toolchain is not None:
                        await self._emit(
                            run,
                            "toolchain_failed",
                            step_id=step.stepId,
                            agent=step.agent,
                            status="failed",
                            payload={**failure_payload, "toolchain": step.toolchain.model_dump()},
                        )
                    step.status = "failed"
                    await self._emit(
                        run,
                        "step_failed",
                        step_id=step.stepId,
                        agent=step.agent,
                        status="failed",
                        payload={"title": step.title, "message": public_message, "code": code},
                    )
                await self._emit(run, "error", payload=failure_payload)
                await self._finish_run(
                    run,
                    "failed",
                    "run_failed",
                    failure_payload,
                )
        finally:
            current_task = asyncio.current_task()
            if self._run_tasks.get(run_id) is current_task:
                self._run_tasks.pop(run_id, None)
            self._active_request_ids.pop(run_id, None)
            self._active_tool_request_ids.pop(run_id, None)
        if pending_operation is not None:
            self._schedule_draft_operation_watcher(run_id, pending_operation)

    async def _advance_execution(self, graph_state: ExecutionState) -> dict[str, Any]:
        try:
            return await self._advance_execution_inner(graph_state)
        except DraftOperationPending as pending:
            return {
                "action": "waiting_operation",
                "pending_operation": {
                    "operationId": pending.operation_id,
                    "operationKey": pending.operation_key,
                    "operationStatus": pending.status,
                    "operationVersion": pending.version,
                    "pollAfterSeconds": pending.poll_after_seconds,
                },
                "resume_response": None,
            }

    async def _advance_execution_inner(self, graph_state: ExecutionState) -> dict[str, Any]:
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
            await self._emit(run, "step_started", step_id=step.stepId, agent=step.agent, payload={
                "title": step.title,
                "skills": [skill.model_dump() for skill in step.skills],
            })
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
                report = await self._normalize_model_output(
                    run,
                    node_id="final_report",
                    source_method="agent.generate_report",
                    raw_value=report,
                    normalizer=self._normalize_final_report,
                )
                content = report["content"]
                conversation_summary = report["conversationSummary"]
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
            except (ToolchainError, AgentRequestError) as error:
                step.status = "failed"
                if isinstance(error, AgentRequestError):
                    payload = {
                        **error.failure.payload(),
                        "message": error.failure.user_message,
                        "toolchain": step.toolchain.model_dump() if step.toolchain else None,
                    }
                else:
                    payload = {**error.payload(), "toolchain": step.toolchain.model_dump() if step.toolchain else None}
                await self._emit(run, "toolchain_failed", step_id=step.stepId, agent=step.agent, status="failed", payload=payload)
                await self._emit(run, "error", step_id=step.stepId, agent=step.agent, payload=payload)
                await self._emit(
                    run,
                    "step_failed",
                    step_id=step.stepId,
                    agent=step.agent,
                    status="failed",
                    payload={"title": step.title, "message": payload["message"], "code": payload["code"]},
                )
                await self._finish_run(run, "failed", "run_failed", payload)
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

        automatic_flow = graph_state.get("approval_mode") == "full_control"

        if not automatic_flow and tool_name == "rag.ask" and not (
            "rag.ask" in plan.goal.lower() and "search.query" in plan.goal.lower()
        ) and not any(
            response.get("checkpointType") == "analysis_scope" for response in run.approvalResponses
        ):
            checkpoint = self._analysis_scope_checkpoint(step.stepId)
            await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
            return {"checkpoint": checkpoint, "action": "waiting_approval", "resume_response": None}

        creative_checked = graph_state["creative_direction_checked"]
        if tool_name in {"chapter.generate_draft", "creative_assets.generate_draft"} and not creative_checked:
            if automatic_flow:
                creative_checked = True
            else:
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
                if checkpoint and not automatic_flow:
                    await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                    update.update({"checkpoint": checkpoint, "action": "waiting_approval"})
            return update
        except DraftOperationPending:
            raise
        except Exception as error:
            step.status = "failed"
            self._classify_local_transform_failure(run, error)
            code = getattr(error, "code", None)
            public_message = self._public_failure_message(run, error)
            details = error.failure.payload() if isinstance(error, AgentRequestError) else (
                error.payload() if isinstance(error, ToolchainError) else {}
            )
            recovery_payload = error.details.get("recovery") if isinstance(error, ToolchainError) else None
            if isinstance(recovery_payload, dict):
                run.recovery = AgentRecoveryDescriptor.model_validate(recovery_payload)
            await self._emit(
                run,
                "error",
                step_id=step.stepId,
                agent=step.agent,
                payload={**details, "message": public_message, "code": code},
            )
            await self._emit(
                run,
                "step_failed",
                step_id=step.stepId,
                agent=step.agent,
                status="failed",
                payload={"title": step.title, "message": public_message, "code": code},
            )
            await self._finish_run(run, "failed", "run_failed", {**details, "message": public_message, "code": code})
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
            target_chapter_id = str(invocation.input.get("chapterId") or graph_state["chapter_id"] or "")
            target_volume_id = str(invocation.input.get("volumeId") or graph_state["volume_id"] or "")
            current_content = str(invocation.input.get("currentContent") or "")
            if not current_content and target_chapter_id == str(graph_state["chapter_id"] or ""):
                current_content = str(graph_state["current_content"] or "")
            raw_input = {
                **invocation.input,
                "novelId": graph_state["novel_id"],
                "chapterId": target_chapter_id,
                "volumeId": target_volume_id,
                "goal": plan.goal,
                "locale": graph_state["locale"],
                "currentContent": current_content,
                "userDecisions": plan.userDecisions or {},
            }
            try:
                validated_input = definition.inputModel.model_validate(raw_input)
            except ValidationError as error:
                raise ToolchainError(
                    "INPUT_INVALID",
                    f"Invalid input for {invocation.id}: {error.errors(include_url=False)}",
                    details={"errors": error.errors(include_url=False)},
                ) from error
            execution_input = validated_input.model_dump()
            if invocation.id in {"novel.bootstrap", "agent_skill.style_extract"}:
                chain_state = {"stage": "generate" if invocation.id == "novel.bootstrap" else "context"}
            elif invocation.id in {"chapter.sequence_continuation", "chapter.batch_rewrite"}:
                chain_state = {}
            elif invocation.id == "creative_asset.draft":
                creative_input = CreativeAssetDraftInput.model_validate(validated_input.model_dump())
                chain_state = initial_creative_asset_state(creative_input)
            elif invocation.id == "novel.project_initialize":
                initialization_input = NovelProjectInitializeInput.model_validate(validated_input.model_dump())
                creative_input = CreativeAssetDraftInput(
                    novelId=initialization_input.novelId,
                    goal=initialization_input.goal,
                    brief=novel_project_initialization_brief(initialization_input.bootstrapDraft),
                    locale=initialization_input.locale,
                    targetSections=initialization_input.targetSections,
                    includeExistingEntities=True,
                    filterCompletedPlotLines=True,
                    maxEstimatedTokens=initialization_input.maxEstimatedTokens,
                )
                chain_state = {
                    **initial_creative_asset_state(creative_input),
                    "bootstrapArtifactId": initialization_input.bootstrapArtifactId,
                    "bootstrapDraft": initialization_input.bootstrapDraft.model_dump(),
                    "initializationSource": "approved_novel_bootstrap",
                }
                execution_input = creative_input.model_dump()
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
                "toolchainInput": execution_input,
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

        if invocation.id in {"creative_asset.draft", "novel.project_initialize"}:
            return await self._advance_creative_asset_toolchain(
                run,
                plan,
                step,
                graph_state,
                chain_state,
                definition,
            )
        if invocation.id in {"novel.bootstrap", "agent_skill.style_extract"}:
            return await self._advance_builtin_skill_workflow(
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
                        self._compile_step_skills(step),
                    ),
                    node_id=node_id,
                )
                review = await self._normalize_model_output(
                    run,
                    node_id=node_id,
                    source_method="agent.generate_consistency_review",
                    raw_value=raw_review,
                    normalizer=lambda value: normalize_review(value, context_bundle),
                )
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
                metadata={
                    "review": review.model_dump(),
                    "contextBundle": context_bundle.model_dump(),
                    "skills": [skill.model_dump() for skill in step.skills],
                },
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

    async def _advance_builtin_skill_workflow(
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
            raise ToolchainError("INPUT_INVALID", "Built-in Skill workflow has no invocation")
        stage = str(chain_state.get("stage") or "generate")

        if invocation.id == "agent_skill.style_extract" and stage == "context":
            node_id = "style_source.read"
            tool_input = dict(chain_state.get("toolchainInput") or {})
            if tool_input.get("sourceMode") == "named_work_model_prior":
                work_title = str(tool_input.get("sourceWorkTitle") or "").strip()
                return {
                    "toolchain_state": {
                        **chain_state,
                        "stage": "plan",
                        "source": {
                            "sourceType": "model_prior",
                            "workTitle": work_title,
                            "chapterCount": 0,
                            "confidence": "low",
                            "coverage": "仅提供作品名称，未读取正文或外部资料。",
                            "warnings": [
                                "仅基于作品名称和模型先验生成；所有文风结论均为低置信度候选。",
                                "未读取《%s》的章节目录或正文。" % work_title,
                            ],
                        },
                        "toolCallCount": 0,
                        "estimatedTokens": 0,
                    },
                    "action": "continue",
                    "resume_response": None,
                }
            scope_tool_input = ChapterScopeContextInput.model_validate(tool_input).model_dump(exclude_none=True)
            await self._emit(
                run,
                "toolchain_node_started",
                step_id=step.stepId,
                agent=step.agent,
                tool_name="chapter.scope_context.build",
                status="running",
                payload={"toolchainId": invocation.id, "nodeId": node_id},
            )
            await self._emit(
                run,
                "tool_call",
                step_id=step.stepId,
                agent=step.agent,
                tool_name="chapter.scope_context.build",
                status="running",
                payload={"summary": "正在读取获准的文风样本范围", "args": scope_tool_input, "toolchainId": invocation.id, "nodeId": node_id},
            )
            try:
                raw_source = await self._tool_invoke(run, "chapter.scope_context.build", scope_tool_input)
            except Exception as error:
                failure = error.failure.payload() if isinstance(error, AgentRequestError) else {}
                await self._emit(
                    run,
                    "tool_result",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name="chapter.scope_context.build",
                    status="failed",
                    payload={
                        "summary": (
                            error.failure.user_message if isinstance(error, AgentRequestError) else "文风样本读取失败。"
                        ),
                        "transport": self.tool_transport,
                        "toolchainId": invocation.id,
                        "nodeId": node_id,
                        "code": failure.get("code") or getattr(error, "code", "NODE_FAILED"),
                        "retryable": failure.get("retryable", False),
                        **({"diagnosticRef": failure["diagnosticRef"]} if failure.get("diagnosticRef") else {}),
                    },
                )
                raise
            source = ChapterScopeBundle.model_validate(raw_source)
            await self._emit(
                run,
                "tool_result",
                step_id=step.stepId,
                agent=step.agent,
                tool_name="chapter.scope_context.build",
                status="completed",
                payload={
                    "summary": f"已读取 {source.coverage.contextChapterCount} 章样本",
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                },
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "stage": "plan",
                    "source": source.model_dump(),
                    "toolCallCount": 1,
                    "estimatedTokens": source.estimatedTokens,
                },
                "action": "continue",
                "resume_response": None,
            }

        if invocation.id == "agent_skill.style_extract" and stage == "plan":
            node_id = "style_pack.plan"
            await self._emit(
                run,
                "toolchain_node_started",
                step_id=step.stepId,
                agent=step.agent,
                status="running",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "kind": "model"},
            )
            raw_plan = await self._automation_invoke(
                run,
                "agent.plan_style_skill_pack",
                workflow_request(
                    goal=plan.goal,
                    locale=graph_state["locale"],
                    user_decisions=plan.userDecisions,
                    source=chain_state.get("source") if isinstance(chain_state.get("source"), dict) else None,
                    agent_skill=self._compile_step_skills(step),
                ),
                node_id=node_id,
            )
            style_plan = await self._normalize_model_output(
                run,
                node_id=node_id,
                source_method="agent.plan_style_skill_pack",
                raw_value=raw_plan,
                normalizer=lambda value: StyleSkillPackAuthoringPlan.model_validate(value),
            )
            first_path = STYLE_SKILL_MEMBER_PATHS[style_plan.skills[0].draftKey]
            workspace = await self._automation_invoke(
                run,
                "agent_skill.workspace.create",
                {
                    "action": "pack",
                    "scope": "novel" if graph_state.get("novel_id") else "user",
                    "sourceNovelId": graph_state.get("novel_id") or None,
                    "logicalPath": first_path,
                    "sourceSnapshotRefs": [
                        str(item.get("sourceId"))
                        for item in (chain_state.get("source") or {}).get("evidence", [])
                        if isinstance(item, dict) and item.get("sourceId")
                    ][:50],
                    "derivationReport": {
                        "kind": "style_skill_pack_extraction",
                        "sourceCoverage": style_plan.sourceCoverage,
                        "omittedDimensions": style_plan.omittedDimensions,
                        "warnings": style_plan.warnings,
                    },
                },
                node_id="style_pack.workspace.create",
            )
            if not isinstance(workspace, dict) or not workspace.get("draftId"):
                raise ToolchainError("DRAFT_PERSIST_FAILED", "Skill Pack workspace store returned an invalid result")
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": node_id,
                    "summary": style_plan.summary[:240],
                    "skillDraftId": workspace.get("draftId"),
                },
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "stage": "author",
                    "stylePlan": style_plan.model_dump(),
                    "skillWorkspace": workspace,
                    "styleMemberIndex": 0,
                    "styleValidationAttempt": 0,
                },
                "action": "continue",
                "resume_response": None,
            }

        if invocation.id == "agent_skill.style_extract" and stage == "author":
            style_plan = StyleSkillPackAuthoringPlan.model_validate(chain_state.get("stylePlan") or {})
            workspace = chain_state.get("skillWorkspace") if isinstance(chain_state.get("skillWorkspace"), dict) else {}
            latest_workspace = await self._automation_invoke(
                run,
                "agent_skill.workspace.list",
                {"draftId": workspace.get("draftId")},
                node_id="style_pack.workspace.refresh.author",
            )
            if isinstance(latest_workspace, dict):
                workspace = latest_workspace
            member_index = int(chain_state.get("styleMemberIndex") or 0)
            if member_index < len(style_plan.skills):
                member = style_plan.skills[member_index]
                logical_path = STYLE_SKILL_MEMBER_PATHS[member.draftKey]
                diagnostics_by_path = chain_state.get("styleDiagnostics") if isinstance(chain_state.get("styleDiagnostics"), dict) else {}
                diagnostics = diagnostics_by_path.get(logical_path) if isinstance(diagnostics_by_path.get(logical_path), list) else []
                current_document = ""
                documents = workspace.get("documents") if isinstance(workspace.get("documents"), list) else []
                document_summary = next((
                    item for item in documents
                    if isinstance(item, dict) and item.get("logicalPath") == logical_path and not item.get("deleted")
                ), None)
                if (
                    isinstance(document_summary, dict)
                    and int(document_summary.get("byteLength") or 0) > 0
                    and not diagnostics
                    and chain_state.get("styleRepairReturnIndex") is None
                    and int(chain_state.get("styleValidationAttempt") or 0) == 0
                ):
                    return {
                        "toolchain_state": {
                            **chain_state,
                            "skillWorkspace": workspace,
                            "styleMemberIndex": member_index + 1,
                        },
                        "action": "continue",
                        "resume_response": None,
                    }
                if isinstance(document_summary, dict):
                    current = await self._automation_invoke(
                        run,
                        "agent_skill.workspace.read",
                        {"draftId": workspace.get("draftId"), "logicalPath": logical_path},
                        node_id=f"style_pack.read.{member.draftKey}",
                    )
                    current_document = str(current.get("contentText") or "") if isinstance(current, dict) else ""
                authoring_goal = (
                    "为文风 Skill Pack 编写一个独立成员。严格采用成员规划中的 stableId、标题、描述、"
                    "guidanceMode、触发条件、支持操作、约束和方法维度；正文把方法维度展开为可执行步骤、"
                    "判断标准、证据边界与去污染规则。不要编写其他成员或 Pack。成员规划："
                    + json.dumps(member.model_dump(), ensure_ascii=False)
                )
                generated = await self._automation_invoke(
                    run,
                    "agent.generate_skill_document",
                    {
                        "goal": authoring_goal,
                        "scope": "novel" if graph_state.get("novel_id") else "user",
                        "novelId": graph_state.get("novel_id") or None,
                        "locale": graph_state["locale"],
                        "creatorProfile": "builtin.style-skill-extractor.member",
                        "targetSkillId": member.stableIdCandidate,
                        "source": {
                            "styleSource": chain_state.get("source") or {},
                            "memberPlan": member.model_dump(),
                        },
                        "currentDocument": current_document,
                        "validationDiagnostics": diagnostics,
                        "attempt": max(1, int(chain_state.get("styleValidationAttempt") or 0) + 1),
                    },
                    node_id=f"style_pack.author.{member.draftKey}",
                )
                content_text = str(generated.get("contentText") or "") if isinstance(generated, dict) else ""
                if not content_text:
                    raise ToolchainError("STYLE_SKILL_DOCUMENT_EMPTY", f"{logical_path} generator returned empty text")
                workspace = await self._automation_invoke(
                    run,
                    "agent_skill.workspace.write",
                    {
                        "draftId": workspace.get("draftId"),
                        "expectedVersion": workspace.get("version"),
                        "logicalPath": logical_path,
                        "mediaType": "text/markdown",
                        "contentText": content_text,
                    },
                    node_id=f"style_pack.write.{member.draftKey}",
                )
                repair_return_index = chain_state.get("styleRepairReturnIndex")
                if repair_return_index is not None:
                    return {
                        "toolchain_state": {
                            **chain_state,
                            "stage": "repair",
                            "skillWorkspace": workspace,
                            "styleRepairIndex": int(repair_return_index),
                            "styleRepairReturnIndex": None,
                        },
                        "action": "continue",
                        "resume_response": None,
                    }
                return {
                    "toolchain_state": {
                        **chain_state,
                        "skillWorkspace": workspace,
                        "styleMemberIndex": member_index + 1,
                    },
                    "action": "continue",
                    "resume_response": None,
                }

            translated_pack = {
                "definition": {
                    "stableId": style_plan.pack.stableIdCandidate,
                    "title": style_plan.pack.title,
                    "description": style_plan.pack.description,
                },
                "revision": {
                    "version": "1.0.0",
                    "bindings": [
                        {
                            "operationId": binding.operationId,
                            "roleId": binding.roleId,
                            "primaryDraftKey": STYLE_SKILL_MEMBER_KEYS[binding.primaryDraftKey],
                            **({"auxiliaryDraftKey": STYLE_SKILL_MEMBER_KEYS[binding.auxiliaryDraftKey]}
                               if binding.auxiliaryDraftKey else {}),
                        }
                        for binding in style_plan.pack.bindings
                    ],
                },
            }
            workspace = await self._automation_invoke(
                run,
                "agent_skill.workspace.set_pack",
                {
                    "draftId": workspace.get("draftId"),
                    "expectedVersion": workspace.get("version"),
                    "pack": translated_pack,
                },
                node_id="style_pack.workspace.set_pack",
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "stage": "validate",
                    "skillWorkspace": workspace,
                },
                "action": "continue",
                "resume_response": None,
            }

        if invocation.id == "agent_skill.style_extract" and stage == "validate":
            workspace = chain_state.get("skillWorkspace") if isinstance(chain_state.get("skillWorkspace"), dict) else {}
            latest_workspace = await self._automation_invoke(
                run,
                "agent_skill.workspace.list",
                {"draftId": workspace.get("draftId")},
                node_id="style_pack.workspace.refresh.validate",
            )
            if isinstance(latest_workspace, dict):
                workspace = latest_workspace
            validation_attempt = int(chain_state.get("styleValidationAttempt") or 0) + 1
            workspace = await self._automation_invoke(
                run,
                "agent_skill.workspace.validate",
                {
                    "draftId": workspace.get("draftId"),
                    "expectedVersion": workspace.get("version"),
                    "finalAttempt": validation_attempt >= 4,
                },
                node_id=f"style_pack.workspace.validate.{validation_attempt}",
            )
            report = workspace.get("validationReport") if isinstance(workspace.get("validationReport"), dict) else {}
            if report.get("ok"):
                return {
                    "toolchain_state": {
                        **chain_state,
                        "stage": "compile",
                        "skillWorkspace": workspace,
                        "styleValidationAttempt": validation_attempt,
                        "styleDiagnostics": {},
                    },
                    "action": "continue",
                    "resume_response": None,
                }
            diagnostics = [item for item in (report.get("diagnostics") or []) if isinstance(item, dict)]
            affected_paths = sorted({
                str(item.get("path") or "") for item in diagnostics
                if str(item.get("path") or "") in STYLE_SKILL_MEMBER_PATHS.values()
            })
            if validation_attempt >= 4 or not affected_paths:
                raise ToolchainError(
                    "STYLE_SKILL_WORKSPACE_NEEDS_ATTENTION",
                    "文风 Skill Pack 草稿未通过校验，已保留在待审核草稿中。",
                    details={
                        "skillDraftId": workspace.get("draftId"),
                        "validationReport": report,
                    },
                )
            diagnostics_by_path = {
                path: [item for item in diagnostics if str(item.get("path") or "") == path]
                for path in affected_paths
            }
            style_plan = StyleSkillPackAuthoringPlan.model_validate(chain_state.get("stylePlan") or {})
            repair_keys = [
                item.draftKey for item in style_plan.skills
                if STYLE_SKILL_MEMBER_PATHS[item.draftKey] in affected_paths
            ]
            return {
                "toolchain_state": {
                    **chain_state,
                    "stage": "repair",
                    "skillWorkspace": workspace,
                    "styleValidationAttempt": validation_attempt,
                    "styleDiagnostics": diagnostics_by_path,
                    "styleRepairKeys": repair_keys,
                    "styleRepairIndex": 0,
                },
                "action": "continue",
                "resume_response": None,
            }

        if invocation.id == "agent_skill.style_extract" and stage == "compile":
            style_plan = StyleSkillPackAuthoringPlan.model_validate(chain_state.get("stylePlan") or {})
            workspace = chain_state.get("skillWorkspace") if isinstance(chain_state.get("skillWorkspace"), dict) else {}
            latest_workspace = await self._automation_invoke(
                run,
                "agent_skill.workspace.list",
                {"draftId": workspace.get("draftId")},
                node_id="style_pack.workspace.refresh.compile",
            )
            if isinstance(latest_workspace, dict):
                workspace = latest_workspace
            if workspace.get("phase") != "compiled" or workspace.get("status") != "ready_for_review":
                workspace = await self._automation_invoke(
                    run,
                    "agent_skill.workspace.compile",
                    {
                        "draftId": workspace.get("draftId"),
                        "expectedVersion": workspace.get("version"),
                    },
                    node_id="style_pack.workspace.compile",
                )
            persisted = await self._automation_invoke(
                run,
                "agent_skill.draft.get",
                {"draftId": workspace.get("draftId")},
                node_id="style_pack.workspace.get",
            )
            if not isinstance(persisted, dict):
                raise ToolchainError("DRAFT_PERSIST_FAILED", "Compiled Skill Pack draft could not be loaded")
            persisted_draft = persisted.get("draft") if isinstance(persisted.get("draft"), dict) else {}
            compiled_by_key = {
                str(item.get("draftKey") or ""): item
                for item in (persisted_draft.get("skills") or [])
                if isinstance(item, dict)
            }
            artifact_skills = []
            for member in style_plan.skills:
                compiled = compiled_by_key.get(STYLE_SKILL_MEMBER_KEYS[member.draftKey]) or {}
                revision = compiled.get("revision") if isinstance(compiled.get("revision"), dict) else {}
                artifact_skills.append({
                    "draftKey": member.draftKey,
                    "stableIdCandidate": member.stableIdCandidate,
                    "title": member.title,
                    "description": member.description,
                    "guidanceMode": member.guidanceMode,
                    "confidence": member.confidence,
                    "triggerHints": member.triggerHints,
                    "antiTriggerHints": member.antiTriggerHints,
                    "supportedOperations": member.supportedOperations,
                    "instructions": str(revision.get("instructions") or ""),
                    "constraints": list(revision.get("constraints") or member.constraints),
                    "evidenceNotes": member.evidenceNotes,
                    "contaminationWarnings": member.contaminationWarnings,
                    "evaluationPrompt": member.evaluationPrompt,
                })
            output = StyleSkillPackDraftArtifact.model_validate({
                "summary": style_plan.summary,
                "sourceCoverage": style_plan.sourceCoverage,
                "skills": artifact_skills,
                "pack": style_plan.pack.model_dump(),
                "omittedDimensions": style_plan.omittedDimensions,
                "warnings": style_plan.warnings,
            })
            artifact = await self._publish_artifact(
                run,
                artifact_type="agent_skill_pack_draft",
                title=output.pack.title,
                summary=output.summary[:500],
                content=style_skill_pack_markdown(output),
                reference={
                    "novelId": graph_state.get("novel_id"),
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                    "skillDraftId": persisted.get("id"),
                },
                metadata={
                    "draft": output.model_dump(),
                    "skills": [skill.model_dump() for skill in step.skills],
                    "source": chain_state.get("source") or {},
                    "skillDraft": persisted,
                },
                step_id=step.stepId,
                agent=step.agent,
            )
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": "style_pack.compile",
                    "artifactId": artifact.artifactId,
                    "summary": output.summary[:240],
                },
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "stage": "completed",
                    "artifactId": artifact.artifactId,
                    "result": output.model_dump(),
                    "skillDraft": persisted,
                    "skillWorkspace": workspace,
                },
                "action": "continue",
                "resume_response": None,
            }

        if invocation.id == "agent_skill.style_extract" and stage == "repair":
            repair_keys = [str(item) for item in (chain_state.get("styleRepairKeys") or [])]
            repair_index = int(chain_state.get("styleRepairIndex") or 0)
            if repair_index >= len(repair_keys):
                return {
                    "toolchain_state": {**chain_state, "stage": "validate"},
                    "action": "continue",
                    "resume_response": None,
                }
            style_plan = StyleSkillPackAuthoringPlan.model_validate(chain_state.get("stylePlan") or {})
            key = repair_keys[repair_index]
            next_member_index = next(
                index for index, item in enumerate(style_plan.skills) if item.draftKey == key
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "stage": "author",
                    "styleMemberIndex": next_member_index,
                    "styleRepairReturnIndex": repair_index + 1,
                },
                "action": "continue",
                "resume_response": None,
            }

        if invocation.id == "agent_skill.style_extract" and stage == "generate":
            raise ToolchainError(
                "TOOLCHAIN_STATE_UNSUPPORTED",
                "This saved Style Skill run used a retired authoring stage; create a new run to use the document workspace flow",
            )

        if invocation.id == "novel.bootstrap" and stage == "generate":
            node_id = "novel_blueprint.synthesize"
            method = "agent.generate_novel_bootstrap"
            await self._emit(
                run,
                "toolchain_node_started",
                step_id=step.stepId,
                agent=step.agent,
                status="running",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "kind": "model"},
            )
            raw_result = await self._automation_invoke(
                run,
                method,
                workflow_request(
                    goal=plan.goal,
                    locale=graph_state["locale"],
                    user_decisions=plan.userDecisions,
                    source=chain_state.get("source") if isinstance(chain_state.get("source"), dict) else None,
                    agent_skill=self._compile_step_skills(step),
                ),
                node_id=node_id,
            )
            output = await self._normalize_model_output(
                run,
                node_id=node_id,
                source_method=method,
                raw_value=raw_result,
                normalizer=lambda value: NovelBootstrapDraft.model_validate(value),
            )
            artifact_type = "novel_bootstrap_draft"
            title = "新小说方案"
            summary = output.corePremise[:500]
            content = novel_bootstrap_markdown(output)
            artifact = await self._publish_artifact(
                run,
                artifact_type=artifact_type,
                title=title,
                summary=summary,
                content=content,
                reference={
                    "novelId": graph_state.get("novel_id"),
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                },
                metadata={
                    "draft": output.model_dump(),
                    "skills": [skill.model_dump() for skill in step.skills],
                    "source": chain_state.get("source") or {},
                },
                step_id=step.stepId,
                agent=step.agent,
            )
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                status="completed",
                payload={"toolchainId": invocation.id, "nodeId": node_id, "artifactId": artifact.artifactId, "summary": summary[:240]},
            )
            return {
                "toolchain_state": {
                    **chain_state,
                    "stage": "completed",
                    "artifactId": artifact.artifactId,
                    "result": output.model_dump(),
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
            chain_state.get("result") or {},
            artifact_id=str(chain_state.get("artifactId") or "") or None,
            tool_call_count=int(chain_state.get("toolCallCount") or 0),
        )

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
                        node_id=node_id,
                    )
                    evaluation = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_reader_chapter_evaluation",
                        raw_value=raw_evaluation,
                        normalizer=lambda value: normalize_reader_chapter_evaluation(value, chapter),
                    )
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
                    node_id = f"audit.{expert}"
                    if expert == "editor":
                        raw = await self._automation_invoke(
                            run,
                            "agent.generate_editor_range_review",
                            editor_range_review_request(plan.goal, graph_state["locale"], bundle, []),
                            node_id=node_id,
                        )
                        return await self._normalize_model_output(
                            run,
                            node_id=node_id,
                            source_method="agent.generate_editor_range_review",
                            raw_value=raw,
                            normalizer=lambda value: normalize_editor_range_review(value, bundle),
                        )
                    raw = await self._automation_invoke(
                        run,
                        "agent.generate_worldbuilding_range_consistency",
                        worldbuilding_consistency_request(plan.goal, graph_state["locale"], bundle, []),
                        node_id=node_id,
                    )
                    return await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_worldbuilding_range_consistency",
                        raw_value=raw,
                        normalizer=lambda value: normalize_worldbuilding_consistency(value, bundle),
                    )

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
                            node_id=node_id,
                        )
                        evaluation = await self._normalize_model_output(
                            run,
                            node_id=node_id,
                            source_method="agent.generate_reader_chapter_evaluation",
                            raw_value=raw,
                            normalizer=lambda value: normalize_reader_chapter_evaluation(value, chapter),
                        )
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
                            node_id=node_id,
                        )
                        extraction = await self._normalize_model_output(
                            run,
                            node_id=node_id,
                            source_method="agent.extract_research_claims",
                            raw_value=raw,
                            normalizer=lambda value: normalize_research_claims(
                                value, bundle, input_data.researchMaxClaims
                            ),
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
                        node_id=node_id,
                    )
                    review = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_research_fact_check",
                        raw_value=raw,
                        normalizer=lambda value: normalize_research_fact_check(
                            value,
                            bundle,
                            research_claims,
                            research_evidence,
                            list(chain_state.get("auditResearchWarnings") or []),
                        ),
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
                        node_id=node_id,
                    )
                    audit = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_scope_audit",
                        raw_value=raw_audit,
                        normalizer=lambda value: normalize_scope_audit(value, bundle, ordered_reports, ordered_refs),
                    )
                except Exception as error:
                    if isinstance(error, ToolchainError) and error.code == "MODEL_OUTPUT_INVALID":
                        raise
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
                        node_id=node_id,
                    )
                    extraction = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.extract_research_claims",
                        raw_value=raw_extraction,
                        normalizer=lambda value: normalize_research_claims(
                            value, bundle, input_data.maxClaims
                        ),
                    )
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
                        node_id=node_id,
                    )
                    review = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_research_fact_check",
                        raw_value=raw_report,
                        normalizer=lambda value: normalize_research_fact_check(
                            value,
                            bundle,
                            claims,
                            search_evidence,
                            [
                                *(chain_state.get("researchExtractionWarnings") or []),
                                *(chain_state.get("warnings") or []),
                            ],
                        ),
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
                        node_id=node_id,
                    )
                    review = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_worldbuilding_range_consistency",
                        raw_value=raw_review,
                        normalizer=lambda value: normalize_worldbuilding_consistency(value, bundle),
                    )
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
                        node_id=node_id,
                    )
                    revision_plan = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_writer_range_revision_plan",
                        raw_value=raw_plan,
                        normalizer=lambda value: normalize_writer_range_revision_plan(value, bundle),
                    )
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
                        node_id=node_id,
                    )
                    review = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method="agent.generate_editor_range_review",
                        raw_value=raw_review,
                        normalizer=lambda value: normalize_editor_range_review(value, bundle),
                    )
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
            if scope is None and graph_state.get("approval_mode") == "full_control":
                scope = "volume" if input_data.volumeId else ("chapter" if input_data.chapterId else "novel")
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
                    node_id=node_id,
                )
                analysis = await self._normalize_model_output(
                    run,
                    node_id=node_id,
                    source_method="agent.generate_plotline_analysis",
                    raw_value=raw_analysis,
                    normalizer=lambda value: normalize_plotline_analysis(value, context),
                )
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
            if checkpoint and graph_state.get("approval_mode") != "full_control":
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
            if graph_state.get("approval_mode") == "full_control":
                return {
                    "toolchain_state": {**chain_state, "creativeDirectionChecked": True},
                    "action": "continue",
                    "resume_response": None,
                }
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
                invocation.input.get("_resolvedTarget")
                if isinstance(invocation.input.get("_resolvedTarget"), dict)
                else None,
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
            except DraftOperationFailed as error:
                await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                raise ToolchainError(
                    "MODEL_OUTPUT_TRUNCATED" if error.code == "MODEL_OUTPUT_TRUNCATED" else "NODE_FAILED",
                    str(error),
                    node_id=node_id,
                    retryable=False,
                    details=error.details,
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

        if input_data.editorialReview and not chain_state.get("draftReview"):
            draft_result = DraftToolchainResult.model_validate(chain_state["draftResult"])
            read_node_id = "draft.review_source"
            read_tool_name = "draft.get"
            self._require_toolchain_tool(definition, read_tool_name, read_node_id)
            read_params = {"draftSessionId": draft_result.draftSessionId}
            await self._emit_toolchain_node_started(run, step, invocation, read_node_id, tool_name=read_tool_name)
            await self._emit_tool_call(run, step, invocation, read_node_id, read_tool_name, read_params)
            try:
                raw_session = await self._tool_invoke(run, read_tool_name, read_params)
                if not isinstance(raw_session, dict):
                    raise ToolchainError(
                        "NODE_FAILED",
                        "draft.get returned no reviewable chapter draft",
                        node_id=read_node_id,
                    )
                if raw_session.get("status", "draft") != "draft" or int(raw_session.get("version") or 1) != draft_result.version:
                    raise ToolchainError("VERSION_CONFLICT", "草稿已变化，请基于当前版本重新审校。", node_id=read_node_id)
                payload = raw_session.get("payload") if isinstance(raw_session.get("payload"), dict) else {}
                draft_text = str(payload.get("generatedText") or payload.get("content") or "").strip()
                if not draft_text:
                    raise ToolchainError(
                        "NODE_FAILED",
                        "The generated DraftSession contains no chapter text to review",
                        node_id=read_node_id,
                    )
            except Exception as error:
                await self._emit_tool_failure(run, step, invocation, read_node_id, read_tool_name, error)
                raise
            source_summary = self._summarize_result(read_tool_name, raw_session)
            await self._emit_tool_success(run, step, invocation, read_node_id, read_tool_name, source_summary)
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent=step.agent,
                tool_name=read_tool_name,
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": read_node_id,
                    "summary": source_summary,
                    "draftSessionId": draft_result.draftSessionId,
                    "draftVersion": raw_session.get("version"),
                },
            )

            review_node_id = "draft.editorial_review"
            if int(chain_state.get("modelCallCount") or 0) >= definition.budget.maxModelCalls:
                raise ToolchainError(
                    "BUDGET_EXCEEDED",
                    "Chapter continuation exhausted its editorial review model budget.",
                    node_id=review_node_id,
                )
            draft_context = context_bundle.model_copy(update={
                "chapter": {
                    **context_bundle.chapter,
                    "id": input_data.chapterId,
                    "content": draft_text,
                    "draftSessionId": draft_result.draftSessionId,
                    "draftVersion": raw_session.get("version"),
                    "contentSource": "draft_session",
                },
            })
            await self._emit_toolchain_node_started(run, step, invocation, review_node_id, kind="model")
            try:
                raw_review = await self._automation_invoke(
                    run,
                    "agent.generate_consistency_review",
                    review_request(
                        plan.goal,
                        graph_state["locale"],
                        draft_context,
                        input_data.reviewDimensions,
                        self._compile_step_skills(step),
                    ),
                    node_id=review_node_id,
                )
                review = await self._normalize_model_output(
                    run,
                    node_id=review_node_id,
                    source_method="agent.generate_consistency_review",
                    raw_value=raw_review,
                    normalizer=lambda value: normalize_review(value, draft_context),
                )
            except AgentRequestError as error:
                if error.code in {"MODEL_OUTPUT_TRUNCATED", "NETWORK_ERROR", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "PROVIDER_AUTH"}:
                    run.recovery = AgentRecoveryDescriptor(
                        failureKind="model_output_truncated" if error.code == "MODEL_OUTPUT_TRUNCATED" else "transport",
                        failedAtPhase="model_pending", retryStrategy="retry_request", canRecover=True,
                        recoveryRevision=run.failureRevision + 1, actionLabel="重试审校",
                        completedArtifactIds=[artifact.artifactId for artifact in run.artifacts],
                        diagnosticRef=error.failure.diagnostic_ref,
                    )
                    self.state.recoveryRecords[run.runId] = {
                        "nodeId": review_node_id, "sourceMethod": "agent.generate_consistency_review",
                        "draftSessionId": draft_result.draftSessionId,
                        "draftVersion": draft_result.version,
                    }
                    self._save()
                raise
            except Exception as error:
                raise ToolchainError(
                    "NODE_FAILED",
                    f"Generated draft editorial review failed: {error}",
                    node_id=review_node_id,
                    retryable=True,
                ) from error
            review_artifact = await self._publish_artifact(
                run,
                artifact_type="consistency_review",
                title="章节草稿编辑审校",
                summary=review.summary[:500],
                content=review_markdown(review),
                reference={
                    "chapterId": input_data.chapterId,
                    "draftSessionId": draft_result.draftSessionId,
                    "draftVersion": raw_session.get("version"),
                    "toolchainId": invocation.id,
                    "version": invocation.version,
                },
                metadata={
                    "review": review.model_dump(),
                    "reviewedDraftSessionId": draft_result.draftSessionId,
                    "reviewedDraftVersion": raw_session.get("version"),
                    "contentSource": "draft_session",
                },
                step_id=step.stepId,
                agent="editor",
            )
            final_draft_result = draft_result
            final_artifact_id = str(chain_state.get("artifactId") or "") or None
            actionable_issues = [
                issue for issue in review.issues
                if issue.severity in {"critical", "high"}
            ]
            revision_artifact_id: str | None = None
            if actionable_issues:
                revision_node_id = "draft.editorial_revision"
                revision_tool_name = "chapter.revise_draft"
                self._require_toolchain_tool(definition, revision_tool_name, revision_node_id)
                review_request_id = new_id("review")
                created_at = utc_now()
                revision_params = {
                    "sourceDraftSessionId": draft_result.draftSessionId,
                    "sourceDraftVersion": int(raw_session.get("version") or draft_result.version),
                    "reviewRequestId": review_request_id,
                    "locale": graph_state["locale"],
                    "comments": [
                        {
                            "commentId": new_id("comment"),
                            "novelId": input_data.novelId,
                            "sourceConversationId": run.threadId,
                            "sourceRunId": run.runId,
                            "sourceArtifactId": review_artifact.artifactId,
                            "reviewVersionId": draft_result.draftSessionId,
                            "draftSessionId": draft_result.draftSessionId,
                            "anchor": {
                                "kind": "chapter",
                                "targetId": input_data.chapterId,
                                "quote": issue.excerpt[:500],
                            },
                            "body": "：".join(part for part in (
                                issue.title.strip(),
                                issue.recommendation.strip(),
                            ) if part),
                            "status": "sent",
                            "sentMode": "regenerate",
                            "createdAt": created_at,
                            "updatedAt": created_at,
                            "sentAt": created_at,
                        }
                        for issue in actionable_issues
                    ],
                }
                await self._emit_toolchain_node_started(
                    run,
                    step,
                    invocation,
                    revision_node_id,
                    tool_name=revision_tool_name,
                )
                await self._emit_tool_call(
                    run,
                    step,
                    invocation,
                    revision_node_id,
                    revision_tool_name,
                    revision_params,
                )
                try:
                    raw_revision = await self._tool_invoke(run, revision_tool_name, revision_params)
                    revised_session = normalize_chapter_draft(raw_revision)
                except SideEffectResultUnknown as error:
                    await self._emit_tool_failure(
                        run, step, invocation, revision_node_id, revision_tool_name, error,
                    )
                    raise ToolchainError(
                        "SIDE_EFFECT_UNKNOWN",
                        str(error),
                        node_id=revision_node_id,
                        details={"invocationKey": error.invocation_key, "method": error.method},
                    ) from error
                except Exception as error:
                    await self._emit_tool_failure(
                        run, step, invocation, revision_node_id, revision_tool_name, error,
                    )
                    raise ToolchainError("NODE_FAILED", str(error), node_id=revision_node_id) from error
                run.draftSessionId = revised_session.draftSessionId
                revision_summary = revised_session.previewSummary or "编辑审校修订草稿已生成，等待用户审核。"
                await self._emit_tool_success(
                    run,
                    step,
                    invocation,
                    revision_node_id,
                    revision_tool_name,
                    revision_summary,
                )
                revision_artifact = await self._publish_artifact(
                    run,
                    artifact_type="chapter_draft",
                    title="编辑审校修订草稿",
                    summary=revision_summary,
                    reference={
                        "draftSessionId": revised_session.draftSessionId,
                        "revisionOfDraftSessionId": draft_result.draftSessionId,
                        "reviewArtifactId": review_artifact.artifactId,
                    },
                    metadata={
                        "toolchainId": invocation.id,
                        "version": invocation.version,
                        "draftSession": revised_session.model_dump(),
                        "reviewArtifactId": review_artifact.artifactId,
                        "reviewRequestId": review_request_id,
                    },
                    step_id=step.stepId,
                    agent="writer",
                    tool_name=revision_tool_name,
                )
                final_draft_result = DraftToolchainResult(
                    draftSessionId=revised_session.draftSessionId,
                    draftType=revised_session.type,
                    status=revised_session.status,
                    version=revised_session.version,
                    previewSummary=revised_session.previewSummary,
                    artifactId=revision_artifact.artifactId,
                    warnings=context_bundle.warnings,
                    contextStats={
                        "toolCallCount": context_bundle.toolCallCount + 3,
                        "estimatedTokens": context_bundle.estimatedTokens,
                        "evidenceCount": len(context_bundle.evidence),
                    },
                )
                final_artifact_id = revision_artifact.artifactId
                revision_artifact_id = revision_artifact.artifactId
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent="writer",
                    tool_name=revision_tool_name,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": revision_node_id,
                        "summary": revision_summary,
                        "artifactId": revision_artifact.artifactId,
                        "draftSessionId": revised_session.draftSessionId,
                        "revisionOfDraftSessionId": draft_result.draftSessionId,
                    },
                )
            updated = {
                **chain_state,
                "draftResult": final_draft_result.model_dump(),
                "artifactId": final_artifact_id,
                "draftReview": review.model_dump(),
                "draftReviewArtifactId": review_artifact.artifactId,
                "reviewedDraftSessionId": draft_result.draftSessionId,
                "reviewedDraftVersion": raw_session.get("version"),
                "draftRevisionArtifactId": revision_artifact_id,
                "toolCallCount": int(chain_state.get("toolCallCount") or 0) + 1 + (1 if actionable_issues else 0),
                "modelCallCount": int(chain_state.get("modelCallCount") or 0) + 1,
            }
            await self._emit(
                run,
                "toolchain_node_completed",
                step_id=step.stepId,
                agent="editor",
                status="completed",
                payload={
                    "toolchainId": invocation.id,
                    "nodeId": review_node_id,
                    "summary": review.summary[:240],
                    "artifactId": review_artifact.artifactId,
                    "draftSessionId": draft_result.draftSessionId,
                    "draftVersion": raw_session.get("version"),
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
                    raw_beats = await self._automation_invoke(run, tool_name, params, node_id=node_id)
                    beats = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method=tool_name,
                        raw_value=raw_beats,
                        normalizer=lambda value: normalize_beat_inputs(value, input_data.chapterCount),
                    )
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
        current_checkpoint_id = f"batch-beats:{batch.draftBatchId}:{batch.outline.revision}"
        resume_response = graph_state.get("resume_response")
        beat_response = resume_response if (
            isinstance(resume_response, dict)
            and resume_response.get("checkpointType") == "chapter_beats"
            and resume_response.get("checkpointId") == current_checkpoint_id
        ) else next((
            response
            for response in reversed(run.approvalResponses)
            if response.get("checkpointType") == "chapter_beats"
            and response.get("checkpointId") == current_checkpoint_id
        ), None)

        if (
            not is_regeneration
            and beat_response is None
            and graph_state.get("approval_mode") == "full_control"
        ):
            beat_response = {
                "checkpointId": current_checkpoint_id,
                "checkpointType": "chapter_beats",
                "draftBatchId": batch.draftBatchId,
                "outlineRevision": batch.outline.revision,
                "selectedOptionIds": ["approve_beats"],
                "freeText": "",
            }

        if not is_regeneration and beat_response is None:
            checkpoint = chapter_beats_checkpoint(step.stepId, batch)
            await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
            return {
                "toolchain_state": {
                    **chain_state,
                    "beatsApprovalRequested": True,
                    "beatsApprovalRevision": batch.outline.revision,
                },
                "checkpoint": checkpoint,
                "action": "waiting_approval",
                "resume_response": None,
            }

        if not is_regeneration:
            response_batch_id = str(beat_response.get("draftBatchId") or batch.draftBatchId)
            response_revision = int(beat_response.get("outlineRevision") or batch.outline.revision)
            if response_batch_id != batch.draftBatchId or response_revision != batch.outline.revision:
                raise ToolchainError(
                    "INPUT_INVALID",
                    "Chapter beat approval does not match the current outline revision",
                    node_id="beats.approve",
                    details={
                        "draftBatchId": batch.draftBatchId,
                        "outlineRevision": batch.outline.revision,
                        "responseDraftBatchId": response_batch_id,
                        "responseOutlineRevision": response_revision,
                    },
                )

            revision_instruction = str(beat_response.get("freeText") or "").strip()
            selected_option_ids = [str(item) for item in (beat_response.get("selectedOptionIds") or [])]
            if revision_instruction:
                revision_count = max(0, batch.outline.revision - 1)
                if revision_count >= MAX_CHAPTER_BEAT_REVISIONS:
                    raise ToolchainError(
                        "BUDGET_EXCEEDED",
                        "Chapter beat revision limit reached",
                        node_id="beats.revise",
                    )
                if batch.outline.status != "draft" or any(child.draftSessionId for child in batch.children):
                    raise ToolchainError(
                        "INPUT_INVALID",
                        "Chapter beats cannot be revised after draft generation has started",
                        node_id="beats.revise",
                    )

                previous_beats = normalize_beat_inputs(
                    [beat.model_dump() for beat in batch.outline.beats],
                    len(batch.outline.beats),
                )
                model_call_count = int(chain_state.get("modelCallCount") or 0)
                tool_call_count = int(chain_state.get("toolCallCount") or 0)
                node_id = f"beats.revise.{batch.outline.revision + 1}"
                tool_name = "agent.generate_chapter_beats"
                self._require_toolchain_tool(definition, tool_name, node_id)
                if model_call_count >= definition.budget.maxModelCalls:
                    raise ToolchainError(
                        "BUDGET_EXCEEDED",
                        "Chapter beat revision budget exhausted",
                        node_id=node_id,
                    )
                params = beat_revision_params(
                    input_data,
                    chain_state["continuationContext"],
                    previous_beats,
                    revision_instruction,
                )
                if is_rewrite:
                    params.update({
                        "taskMode": "batch_rewrite",
                        "targetChapterIds": input_data.chapterIds,
                    })

                async def pause_revision(error: Exception, state: dict[str, Any]) -> dict[str, Any]:
                    checkpoint = chapter_beats_checkpoint(step.stepId, batch, revision_error=str(error))
                    await self._pause_run_for_graph(run, step.stepId, step.agent, checkpoint)
                    return {
                        "toolchain_state": {
                            **state,
                            "beatsApprovalRequested": True,
                            "beatsApprovalRevision": batch.outline.revision,
                        },
                        "checkpoint": checkpoint,
                        "action": "waiting_approval",
                        "resume_response": None,
                    }

                await self._emit_toolchain_node_started(run, step, invocation, node_id, tool_name=tool_name, kind="model")
                await self._emit_tool_call(run, step, invocation, node_id, tool_name, params)
                try:
                    raw_revised_beats = await self._automation_invoke(
                        run,
                        tool_name,
                        params,
                        node_id=node_id,
                    )
                    revised_beats = await self._normalize_model_output(
                        run,
                        node_id=node_id,
                        source_method=tool_name,
                        raw_value=raw_revised_beats,
                        normalizer=lambda value: normalize_beat_inputs(value, len(previous_beats)),
                    )
                except Exception as error:
                    await self._emit_tool_failure(run, step, invocation, node_id, tool_name, error)
                    if isinstance(error, ToolchainError) and error.code == "MODEL_OUTPUT_INVALID":
                        raise
                    await self._emit(
                        run,
                        "toolchain_node_completed",
                        step_id=step.stepId,
                        agent=step.agent,
                        tool_name=tool_name,
                        status="failed",
                        payload={"toolchainId": invocation.id, "nodeId": node_id, "summary": str(error), "kind": "model"},
                    )
                    return await pause_revision(error, {
                        **chain_state,
                        "toolCallCount": tool_call_count + 1,
                        "modelCallCount": model_call_count + 1,
                    })

                summary = f"已按调整意见生成第 {batch.outline.revision + 1} 版章节节拍。"
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
                        "kind": "model",
                        "outlineRevision": batch.outline.revision + 1,
                    },
                )

                update_node_id = f"beats.update.{batch.outline.revision + 1}"
                update_tool_name = "draft.batch.update_outline"
                self._require_toolchain_tool(definition, update_tool_name, update_node_id)
                update_params = {
                    "draftBatchId": batch.draftBatchId,
                    "version": batch.version,
                    "beats": [beat.model_dump() for beat in revised_beats],
                }
                await self._emit_toolchain_node_started(run, step, invocation, update_node_id, tool_name=update_tool_name)
                await self._emit_tool_call(run, step, invocation, update_node_id, update_tool_name, update_params)
                update_error: Exception | None = None
                unknown_update: SideEffectResultUnknown | None = None
                try:
                    revised_batch = normalize_draft_batch(
                        await self._tool_invoke(run, update_tool_name, update_params),
                        update_node_id,
                    )
                except SideEffectResultUnknown as error:
                    unknown_update = error
                    update_error = error
                    revised_batch = normalize_draft_batch(
                        await self._tool_invoke(run, "draft.batch.get", {"draftBatchId": batch.draftBatchId}),
                        "beats.update.reconcile",
                    )
                except Exception as error:
                    update_error = error
                    try:
                        revised_batch = normalize_draft_batch(
                            await self._tool_invoke(run, "draft.batch.get", {"draftBatchId": batch.draftBatchId}),
                            "beats.update.reconcile",
                        )
                    except Exception:
                        await self._emit_tool_failure(run, step, invocation, update_node_id, update_tool_name, error)
                        raise

                proposed_values = [beat.model_dump() for beat in revised_beats]
                revised_values = [
                    ChapterBeatInput.model_validate(beat.model_dump()).model_dump()
                    for beat in revised_batch.outline.beats
                ]
                previous_values = [beat.model_dump() for beat in previous_beats]
                update_applied = (
                    revised_batch.outline.revision == batch.outline.revision + 1
                    and revised_values == proposed_values
                    and revised_batch.draftBatchId == batch.draftBatchId
                )
                update_unchanged = (
                    revised_batch.outline.revision == batch.outline.revision
                    and revised_values == previous_values
                    and revised_batch.version == batch.version
                )
                if unknown_update and update_applied:
                    self.store.reconcile_invocation(
                        unknown_update.invocation_key,
                        "reconciled_succeeded",
                        result=revised_batch.model_dump(),
                        note="The updated outline was verified by draft.batch.get.",
                    )
                    update_error = None
                elif unknown_update and update_unchanged:
                    self.store.reconcile_invocation(
                        unknown_update.invocation_key,
                        "reconciled_absent",
                        note="draft.batch.get confirmed that the outline was unchanged.",
                    )

                if not update_applied:
                    error = update_error or ToolchainError(
                        "VERSION_CONFLICT",
                        "Draft batch outline changed while applying the revised beats",
                        node_id=update_node_id,
                    )
                    await self._emit_tool_failure(run, step, invocation, update_node_id, update_tool_name, error)
                    await self._emit(
                        run,
                        "toolchain_node_completed",
                        step_id=step.stepId,
                        agent=step.agent,
                        tool_name=update_tool_name,
                        status="failed",
                        payload={"toolchainId": invocation.id, "nodeId": update_node_id, "summary": str(error)},
                    )
                    if update_unchanged:
                        return await pause_revision(error, {
                            **chain_state,
                            "toolCallCount": tool_call_count + 2,
                            "modelCallCount": model_call_count + 1,
                        })
                    raise ToolchainError(
                        "VERSION_CONFLICT",
                        "Draft batch outline changed while applying the revised beats",
                        node_id=update_node_id,
                        details={
                            "expectedRevision": batch.outline.revision,
                            "actualRevision": revised_batch.outline.revision,
                        },
                    ) from error

                update_summary = f"第 {revised_batch.outline.revision} 版章节节拍已保存，等待确认。"
                await self._emit_tool_success(run, step, invocation, update_node_id, update_tool_name, update_summary)
                await self._emit(
                    run,
                    "toolchain_node_completed",
                    step_id=step.stepId,
                    agent=step.agent,
                    tool_name=update_tool_name,
                    status="completed",
                    payload={
                        "toolchainId": invocation.id,
                        "nodeId": update_node_id,
                        "summary": update_summary,
                        "draftBatchId": revised_batch.draftBatchId,
                        "outlineRevision": revised_batch.outline.revision,
                    },
                )
                self._save()
                return {
                    "toolchain_state": {
                        **chain_state,
                        "beats": [beat.model_dump() for beat in revised_batch.outline.beats],
                        "draftBatch": revised_batch.model_dump(),
                        "beatsApprovalRequested": False,
                        "beatsApprovalRevision": batch.outline.revision,
                        "toolCallCount": tool_call_count + 2,
                        "modelCallCount": model_call_count + 1,
                    },
                    "action": "continue",
                    "resume_response": None,
                }

            if selected_option_ids != ["approve_beats"]:
                raise ToolchainError("INPUT_INVALID", "Chapter beats were not approved", node_id="beats.approve")

        if batch.outline.status != "approved":
            node_id = "beats.approve"
            tool_name = "draft.batch.approve_outline"
            self._require_toolchain_tool(definition, tool_name, node_id)
            params = {
                "draftBatchId": batch.draftBatchId,
                "version": batch.version,
                "outlineRevision": batch.outline.revision,
                "approvedBy": (
                    "automatic-policy"
                    if graph_state.get("approval_mode") == "full_control"
                    else "agent-user"
                ),
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
            if graph_state.get("approval_mode") == "full_control":
                return {
                    "toolchain_state": {**chain_state, "creativeDirectionChecked": True},
                    "action": "continue",
                    "resume_response": None,
                }
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
                    **({
                        "bootstrapArtifactId": chain_state["bootstrapArtifactId"],
                        "initializationSource": "approved_novel_bootstrap",
                    } if invocation.id == "novel.project_initialize" and chain_state.get("bootstrapArtifactId") else {}),
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
            + (2 if invocation.id in {"creative_asset.draft", "novel.project_initialize"} else 1),
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
        report_output = output
        if isinstance(output, dict) and output.get("draftSessionId"):
            report_output = {
                **output,
                "generationCompleted": True,
                "editorialReviewCompleted": bool(chain_state.get("draftReviewArtifactId")),
                "editorialRevisionCompleted": bool(chain_state.get("draftRevisionArtifactId")),
                "reviewArtifactId": chain_state.get("draftReviewArtifactId"),
                "reviewSummary": (chain_state.get("draftReview") or {}).get("summary", ""),
                "warningScope": "Context retrieval warnings do not mean draft generation failed.",
            }
        if invocation.id == "novel.bootstrap" and isinstance(output, dict):
            report_output = {
                "type": "novel_bootstrap_draft",
                "status": "ready",
                "artifactId": artifact_id,
                "summary": output.get("corePremise", ""),
                "titleCandidates": output.get("titleCandidates", []),
                "targetChapterCount": output.get("targetChapterCount"),
                "targetWordsPerChapter": output.get("targetWordsPerChapter"),
                "chapterPlan": output.get("chapterPlan", []),
                "warnings": output.get("warnings", []),
            }
        findings = [
            *graph_state["report_findings"],
            {
                "toolName": f"toolchain:{invocation.id}@{invocation.version}",
                "stepTitle": step.title,
                "data": report_output if invocation.id == "novel.bootstrap" else self._compact_report_result(report_output),
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
        raw_questions = result.get("questions")
        if not isinstance(raw_questions, list) and isinstance(result.get("options"), list):
            raw_questions = [{
                "questionId": "creative_direction",
                "header": str(result.get("title") or "创作方向"),
                "prompt": str(result.get("question") or "请选择本次草稿采用的创作方向。"),
                "recommendationReason": str(result.get("reason") or "第一项最贴合当前已读内容。"),
                "options": [
                    {
                        "optionId": str(option.get("id") or f"direction_{index + 1}"),
                        "label": option.get("label"),
                        "description": option.get("description"),
                    }
                    for index, option in enumerate(result.get("options") or [])
                    if isinstance(option, dict)
                ],
            }]
        if not isinstance(raw_questions, list) or not 1 <= len(raw_questions) <= 3:
            raise ValueError("Creative direction detector must return 1 to 3 questions")
        questions: list[dict[str, Any]] = []
        for question_index, raw_question in enumerate(raw_questions):
            if not isinstance(raw_question, dict):
                raise ValueError("Creative direction detector returned an invalid question")
            raw_options = raw_question.get("options")
            if not isinstance(raw_options, list) or not 2 <= len(raw_options) <= 3:
                raise ValueError("Creative direction question must return 2 to 3 options")
            options: list[AgentUserInputOption] = []
            for option_index, raw_option in enumerate(raw_options):
                if not isinstance(raw_option, dict):
                    raise ValueError("Creative direction detector returned an invalid option")
                label = str(raw_option.get("label") or "").strip()[:120]
                description = str(raw_option.get("description") or "").strip()[:500]
                if not label or not description:
                    raise ValueError("Creative direction option label and description are required")
                options.append(AgentUserInputOption(
                    optionId=str(raw_option.get("optionId") or f"direction_{question_index + 1}_{option_index + 1}"),
                    label=label,
                    description=description,
                ))
            questions.append(AgentUserInputQuestion(
                questionId=str(raw_question.get("questionId") or f"creative_direction_{question_index + 1}"),
                header=str(raw_question.get("header") or "创作方向")[:24],
                prompt=str(raw_question.get("prompt") or "请选择本次草稿采用的创作方向。")[:500],
                options=options,
                recommendedOptionId=options[0].optionId,
                recommendationReason=str(raw_question.get("recommendationReason") or options[0].description)[:500],
                allowCustom=True,
            ).model_dump())
        return {
            "checkpointId": new_id("chk"),
            "checkpointType": "creative_direction",
            "title": str(result.get("title") or "创作方向确认").strip()[:120] or "创作方向确认",
            "reason": str(result.get("reason") or "不同方向会显著改变草稿结果，需要由你决定。").strip()[:1000],
            "questions": questions,
            "stepId": step_id,
        }

    async def _pause_run_for_graph(
        self,
        run: AgentRun,
        step_id: str,
        agent: str,
        checkpoint: dict[str, Any],
    ) -> None:
        raw_questions = checkpoint.get("questions") if isinstance(checkpoint.get("questions"), list) else None
        if raw_questions:
            questions = [AgentUserInputQuestion.model_validate(question) for question in raw_questions]
        else:
            if len(checkpoint.get("options") or []) < 2:
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
                return
            options = [AgentUserInputOption(
                optionId=str(option.get("id") or f"option_{index + 1}"),
                label=str(option.get("label") or f"选项 {index + 1}"),
                description=str(option.get("description") or option.get("label") or "采用此方向。"),
            ) for index, option in enumerate(checkpoint.get("options") or [])]
            if len(options) < 2:
                raise ValueError("User input checkpoint requires at least two options")
            questions = [AgentUserInputQuestion(
                questionId=str(checkpoint.get("checkpointType") or "user_decision"),
                header=str(checkpoint.get("title") or "需要确认")[:24],
                prompt=str(checkpoint.get("question") or "请选择本次任务采用的方向。")[:500],
                options=options[:3],
                recommendedOptionId=options[0].optionId,
                recommendationReason=str(checkpoint.get("reason") or options[0].description)[:500],
                allowCustom=True,
            )]
        request = AgentUserInputRequest(
            requestId=new_id("input"),
            inputSessionId=new_id("input_session"),
            conversationId=run.threadId,
            sourceMessageId=str(checkpoint.get("sourceMessageId") or "").strip() or None,
            phase="execution",
            round=1,
            maxRounds=1,
            title=str(checkpoint.get("title") or "需要你确认")[:120],
            reason=str(checkpoint.get("reason") or "该选择会实质改变后续执行结果。")[:1000],
            questions=questions,
            evidence=[],
            runId=run.runId,
            stepId=step_id,
        )
        run.status = "waiting_user_input"
        # Keep the singular checkpoint only as an internal transition aid for older callers;
        # the renderer and persisted active state use pendingUserInput.
        run.pendingApproval = checkpoint
        run.pendingUserInput = request
        self.state.pendingUserInputs[request.requestId] = {
            "request": request.model_dump(),
            "conversationId": run.threadId,
            "checkpointType": str(checkpoint.get("checkpointType") or "user_decision"),
            "checkpoint": checkpoint,
        }
        self._save()
        await self._emit(
            run,
            "user_input_required",
            step_id=step_id,
            agent=agent,
            status="waiting_user_input",
            payload=request.model_dump(),
        )

    def run_status(self, params: dict[str, Any]) -> AgentRunStatusResult:
        run_id = str(params.get("runId") or "")
        run = self.state.runs.get(run_id)
        if not run:
            raise ValueError("runId not found")
        self._refresh_local_recovery_capability(run)
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
            deadlineAt=run.deadlineAt,
            currentStepId=run.currentStepId,
            currentStepTitle=current_step_title,
            totalSteps=len(plan.steps) if plan else 0,
            completedSteps=completed_steps,
            lastSequence=last_event.sequence if last_event else 0,
            lastEventAt=last_event.createdAt if last_event else None,
            draftSessionId=run.draftSessionId,
            draftBatchId=run.draftBatchId,
            draftOperationId=run.draftOperationId,
            draftOperationKey=run.draftOperationKey,
            draftOperationStatus=run.draftOperationStatus,
            draftOperationVersion=run.draftOperationVersion,
            artifacts=run.artifacts,
            pendingApproval=run.pendingApproval,
            pendingUserInput=run.pendingUserInput,
            retryOfRunId=run.retryOfRunId,
            retryRootRunId=run.retryRootRunId,
            retryAttempt=run.retryAttempt,
            failureRevision=run.failureRevision,
            completionKind=run.completionKind,
            recovery=run.recovery,
        )

    async def cancel(self, params: dict[str, Any]) -> AgentRun:
        run_id = str(params.get("runId") or "")
        run = self.state.runs.get(run_id)
        if not run:
            raise ValueError("runId not found")
        was_waiting_approval = run.status in {"waiting_approval", "waiting_user_input"}
        if run.status in {"running", "waiting_approval", "waiting_user_input"}:
            run.status = "cancelling"
            run.cancelRequested = True
        elif run.status == "cancelling":
            run.cancelRequested = True
        self._save()
        request_ids = list(self._active_request_ids.get(run_id) or set())
        tool_request_ids = set(self._active_tool_request_ids.get(run_id) or set())
        operation_timer = self._operation_watch_timers.pop(run_id, None)
        if operation_timer is not None:
            operation_timer.cancel()
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
        if run.draftOperationId and operation_timer is not None and (not task or task.done()):
            try:
                await self._cancel_draft_operation(run.draftOperationId)
            except Exception:
                pass
            await self._finish_run(
                run,
                "cancelled",
                "run_cancelled",
                {"reason": "User cancelled durable draft operation", "operationId": run.draftOperationId},
            )
        if was_waiting_approval and (not task or task.done()):
            run.pendingApproval = None
            if run.pendingUserInput:
                self.state.pendingUserInputs.pop(run.pendingUserInput.requestId, None)
            run.pendingUserInput = None
            await self._finish_run(run, "cancelled", "run_cancelled", {"reason": "User cancelled pending approval"})
        return run

    def _validate_user_input_answers(
        self,
        request: AgentUserInputRequest,
        raw_answers: Any,
    ) -> list[AgentUserInputAnswer]:
        if not isinstance(raw_answers, list):
            raise ValueError("answers must be an array")
        answers = [AgentUserInputAnswer.model_validate(item) for item in raw_answers]
        expected_ids = [question.questionId for question in request.questions]
        answer_ids = [answer.questionId for answer in answers]
        if answer_ids != expected_ids:
            raise ValueError("Answers must include every question once and preserve question order")
        for question, answer in zip(request.questions, answers, strict=True):
            if answer.answerKind == "option":
                allowed = {option.optionId for option in question.options}
                if answer.selectedOptionId not in allowed:
                    raise ValueError(f"Unknown option for question {question.questionId}")
            elif answer.answerKind == "custom" and not question.allowCustom:
                raise ValueError(f"Question {question.questionId} does not allow custom input")
        return answers

    def _effective_user_input_answers(
        self,
        request: AgentUserInputRequest,
        answers: list[AgentUserInputAnswer],
    ) -> list[AgentUserInputEffectiveAnswer]:
        effective: list[AgentUserInputEffectiveAnswer] = []
        for question, answer in zip(request.questions, answers, strict=True):
            if answer.answerKind == "skipped":
                effective.append(AgentUserInputEffectiveAnswer(
                    questionId=answer.questionId,
                    answerKind="option",
                    selectedOptionId=question.recommendedOptionId,
                    source="recommended_fallback",
                ))
            elif answer.answerKind == "custom":
                effective.append(AgentUserInputEffectiveAnswer(
                    questionId=answer.questionId,
                    answerKind="custom",
                    customText=answer.customText,
                    source="user",
                ))
            else:
                effective.append(AgentUserInputEffectiveAnswer(
                    questionId=answer.questionId,
                    answerKind="option",
                    selectedOptionId=answer.selectedOptionId,
                    source="user",
                ))
        return effective

    def _deterministic_user_input_summary(
        self,
        request: AgentUserInputRequest,
        answers: list[AgentUserInputAnswer],
    ) -> str:
        parts: list[str] = []
        for question, answer in zip(request.questions, answers, strict=True):
            if answer.answerKind == "custom":
                value = answer.customText or ""
            elif answer.answerKind == "skipped":
                option = next(item for item in question.options if item.optionId == question.recommendedOptionId)
                value = f"已跳过（采用推荐项：{option.label}）"
            else:
                option = next(item for item in question.options if item.optionId == answer.selectedOptionId)
                value = option.label
            parts.append(f"{question.header}：{value}")
        return "；".join(parts)

    async def _understand_user_input(
        self,
        request: AgentUserInputRequest,
        answers: list[AgentUserInputAnswer],
        effective_answers: list[AgentUserInputEffectiveAnswer],
    ) -> str:
        fallback = self._deterministic_user_input_summary(request, answers)
        try:
            result = await self._retryable_automation_invoke(
                None,
                "agent.summarize_user_input",
                {
                    "request": request.model_dump(),
                    "answers": [answer.model_dump() for answer in answers],
                    "effectiveAnswers": [answer.model_dump() for answer in effective_answers],
                    "fallbackSummary": fallback,
                },
            )
            if isinstance(result, dict):
                summary = str(result.get("summary") or "").strip()
                if summary:
                    return summary[:2000]
        except Exception:
            pass
        return fallback

    def _build_follow_up_user_input_request(
        self,
        result: Any,
        previous: AgentUserInputRequest,
        decision_history: list[dict[str, Any]],
    ) -> AgentUserInputRequest | None:
        if not isinstance(result, dict) or result.get("needsFollowUp") is not True:
            return None
        raw_request = result.get("inputRequest")
        if not isinstance(raw_request, dict):
            raise ValueError("Follow-up response omitted inputRequest")
        raw_questions = raw_request.get("questions")
        if not isinstance(raw_questions, list) or not 1 <= len(raw_questions) <= 3:
            raise ValueError("Follow-up must contain 1 to 3 questions")
        prior_questions = [
            question
            for decision in decision_history
            if isinstance(decision, dict)
            for question in (decision.get("questions") or [])
            if isinstance(question, dict)
        ]
        prior_prompts = {
            " ".join(str(question.get("prompt") or "").lower().split())
            for question in [*prior_questions, *(question.model_dump() for question in previous.questions)]
            if str(question.get("prompt") or "").strip()
        }
        prior_question_ids = {
            str(question.get("questionId") or "").strip()
            for question in [*prior_questions, *(question.model_dump() for question in previous.questions)]
            if str(question.get("questionId") or "").strip()
        }
        evidence_ids = [item.evidenceId for item in previous.evidence]
        questions: list[AgentUserInputQuestion] = []
        for question_index, raw_question in enumerate(raw_questions):
            if not isinstance(raw_question, dict):
                raise ValueError("Follow-up question is invalid")
            prompt = str(raw_question.get("prompt") or "").strip()[:500]
            question_id = str(raw_question.get("questionId") or f"followup_{previous.round + 1}_{question_index + 1}").strip()[:80]
            if not prompt or " ".join(prompt.lower().split()) in prior_prompts or question_id in prior_question_ids:
                raise ValueError("Follow-up question repeats an earlier question")
            raw_options = raw_question.get("options")
            if not isinstance(raw_options, list) or not 2 <= len(raw_options) <= 3:
                raise ValueError("Follow-up question must contain 2 to 3 options")
            options: list[AgentUserInputOption] = []
            for option_index, raw_option in enumerate(raw_options):
                if not isinstance(raw_option, dict):
                    raise ValueError("Follow-up option is invalid")
                label = str(raw_option.get("label") or "").strip()[:120]
                description = str(raw_option.get("description") or "").strip()[:500]
                if not label or not description:
                    raise ValueError("Follow-up option requires label and description")
                options.append(AgentUserInputOption(
                    optionId=str(raw_option.get("optionId") or f"followup_{question_index + 1}_{option_index + 1}")[:80],
                    label=label,
                    description=description,
                    evidenceIds=evidence_ids,
                ))
            questions.append(AgentUserInputQuestion(
                questionId=question_id,
                header=str(raw_question.get("header") or "综合取舍").strip()[:24] or "综合取舍",
                prompt=prompt,
                options=options,
                recommendedOptionId=options[0].optionId,
                recommendationReason=str(raw_question.get("recommendationReason") or options[0].description).strip()[:500],
                evidenceIds=evidence_ids,
                allowCustom=True,
            ))
        return AgentUserInputRequest(
            requestId=new_id("input"),
            inputSessionId=previous.inputSessionId,
            conversationId=previous.conversationId,
            sourceMessageId=previous.sourceMessageId,
            phase="pre_plan",
            round=previous.round + 1,
            maxRounds=previous.maxRounds,
            previousRequestId=previous.requestId,
            title=str(raw_request.get("title") or "再确认一个关键取舍").strip()[:120],
            reason=str(raw_request.get("reason") or "这项取舍会改变计划的核心安排。").strip()[:1000],
            questions=questions,
            evidence=previous.evidence,
        )

    @staticmethod
    def _is_novel_bootstrap_planning(planning: dict[str, Any]) -> bool:
        decision = planning.get("intentDecision")
        if not isinstance(decision, dict):
            return False
        return any(
            isinstance(operation, dict) and operation.get("type") == "novel.bootstrap"
            for operation in (decision.get("operations") or [])
        )

    async def _request_user_input_follow_up(
        self,
        request: AgentUserInputRequest,
        answers: list[AgentUserInputAnswer],
        effective_answers: list[AgentUserInputEffectiveAnswer],
        understanding_summary: str,
        planning: dict[str, Any],
    ) -> AgentUserInputRequest | None:
        if request.phase != "pre_plan" or request.round >= request.maxRounds:
            return None
        is_novel_bootstrap = self._is_novel_bootstrap_planning(planning)
        prior_rounds = planning.get("decisionRounds") if isinstance(planning.get("decisionRounds"), list) else []
        decision_history = [
            *[item for item in prior_rounds if isinstance(item, dict)],
            {
                "requestId": request.requestId,
                "round": request.round,
                "questions": [question.model_dump() for question in request.questions],
                "answers": [answer.model_dump() for answer in answers],
                "effectiveAnswers": [answer.model_dump() for answer in effective_answers],
                "understandingSummary": understanding_summary,
            },
        ]
        try:
            result = await self._retryable_automation_invoke(
                None,
                "agent.generate_user_input_followup",
                {
                    "goal": str(planning.get("goal") or ""),
                    "role": str(planning.get("role") or "team"),
                    "locale": str(planning.get("locale") or "zh-CN"),
                    "request": request.model_dump(),
                    "answers": [answer.model_dump() for answer in answers],
                    "effectiveAnswers": [answer.model_dump() for answer in effective_answers],
                    "understandingSummary": understanding_summary,
                    "previousQuestions": [question.model_dump() for question in request.questions],
                    "decisionHistory": decision_history,
                    "evidence": [item.model_dump() for item in request.evidence],
                    "workflow": "novel_bootstrap" if is_novel_bootstrap else "general",
                    "novelId": str(planning.get("novelId") or "").strip() or None,
                },
            )
            return self._build_follow_up_user_input_request(result, request, decision_history)
        except Exception:
            # New-novel deep customization is a deliberate product phase. Do not
            # silently turn a failed adaptive interview into a final blueprint.
            if is_novel_bootstrap:
                raise
            return None

    async def submit_user_input(self, params: dict[str, Any], context: dict[str, Any]) -> AgentUserInputResolution:
        request_id = str(params.get("requestId") or "")
        if not request_id:
            raise ValueError("requestId is required")
        lock = self._user_input_locks.setdefault(request_id, asyncio.Lock())
        async with lock:
            return await self._submit_user_input_locked(params, context)

    async def _submit_user_input_locked(
        self,
        params: dict[str, Any],
        context: dict[str, Any],
    ) -> AgentUserInputResolution:
        request_id = str(params.get("requestId") or "")
        resolved_payload = self.state.userInputResolutions.get(request_id)
        if resolved_payload:
            return AgentUserInputResolution.model_validate(resolved_payload)
        pending_entry = self.state.pendingUserInputs.get(request_id)
        if not pending_entry:
            raise ValueError("User input request is no longer pending")
        request = AgentUserInputRequest.model_validate(pending_entry.get("request"))
        if params.get("conversationId") and str(params.get("conversationId")) != request.conversationId:
            raise ValueError("conversationId does not match pending user input")
        answers = self._validate_user_input_answers(request, params.get("answers"))
        effective_answers = self._effective_user_input_answers(request, answers)
        understanding_summary = await self._understand_user_input(request, answers, effective_answers)
        decision_payload = {
            "requestId": request.requestId,
            "inputSessionId": request.inputSessionId,
            "round": request.round,
            "answers": [answer.model_dump() for answer in answers],
            "effectiveAnswers": [answer.model_dump() for answer in effective_answers],
            "understandingSummary": understanding_summary,
            "questions": [question.model_dump() for question in request.questions],
        }
        if request.phase == "pre_plan":
            planning = pending_entry.get("planning") if isinstance(pending_entry.get("planning"), dict) else {}
            prior_rounds = planning.get("decisionRounds") if isinstance(planning.get("decisionRounds"), list) else []
            decision_rounds = [*prior_rounds, decision_payload]
            follow_up = await self._request_user_input_follow_up(
                request,
                answers,
                effective_answers,
                understanding_summary,
                planning,
            )
            if follow_up is not None:
                self.state.pendingUserInputs.pop(request_id, None)
                self.state.pendingUserInputs[follow_up.requestId] = {
                    "request": follow_up.model_dump(),
                    "conversationId": request.conversationId,
                    "planning": {**planning, "decisionRounds": decision_rounds},
                }
                resolution = AgentUserInputResolution(
                    requestId=request_id,
                    inputSessionId=request.inputSessionId,
                    round=request.round,
                    phase="pre_plan",
                    status="resolved",
                    answers=answers,
                    effectiveAnswers=effective_answers,
                    understandingSummary=understanding_summary,
                    nextAction="follow_up_required",
                    request=request,
                    pendingUserInput=follow_up,
                )
                self.state.userInputResolutions[request_id] = resolution.model_dump()
                self._save()
                return resolution
            plan_params = {
                "goal": str(planning.get("goal") or ""),
                "role": str(planning.get("role") or "team"),
                "locale": str(planning.get("locale") or context.get("locale") or "zh-CN"),
                "chapterScope": planning.get("chapterScope"),
                "chapterId": planning.get("chapterId"),
                "novelId": planning.get("novelId"),
                "intentDecision": planning.get("intentDecision"),
                "userDecisions": {
                    "inputSessionId": request.inputSessionId,
                    "rounds": decision_rounds,
                    # Keep the latest round at the top level for existing planner
                    # integrations while the complete authoritative history lives
                    # in rounds.
                    "requestId": decision_payload["requestId"],
                    "answers": decision_payload["answers"],
                    "effectiveAnswers": decision_payload["effectiveAnswers"],
                    "understandingSummary": "；".join(
                        str(item.get("understandingSummary") or "") for item in decision_rounds
                        if str(item.get("understandingSummary") or "").strip()
                    ),
                },
            }
            plan = await self.plan(plan_params, context)
            resolution = AgentUserInputResolution(
                requestId=request_id,
                inputSessionId=request.inputSessionId,
                round=request.round,
                phase="pre_plan",
                answers=answers,
                effectiveAnswers=effective_answers,
                understandingSummary=understanding_summary,
                nextAction="plan_created",
                request=request,
                plan=plan,
            )
        else:
            run_id = str(request.runId or "")
            run = self.state.runs.get(run_id)
            if not run or not run.pendingUserInput or run.pendingUserInput.requestId != request_id:
                raise ValueError("Run no longer waits for this user input request")
            active_task = self._run_tasks.get(run_id)
            if active_task and not active_task.done():
                await active_task
            checkpoint_type = str(pending_entry.get("checkpointType") or "user_decision")
            option_ids = [answer.selectedOptionId for answer in effective_answers if answer.selectedOptionId]
            custom_parts = [answer.customText for answer in effective_answers if answer.customText]
            execution_summary = self._deterministic_user_input_summary(request, answers)
            compatibility_response = {
                "checkpointId": request_id,
                "checkpointType": checkpoint_type,
                "selectedOptionIds": option_ids,
                "freeText": "\n".join(custom_parts),
                # Execution always consumes a deterministic rendering of the raw answers.
                # The model-generated understanding is presentation-only and may never
                # override what the user actually selected or typed.
                "summary": execution_summary,
                "answers": [answer.model_dump() for answer in answers],
                "effectiveAnswers": [answer.model_dump() for answer in effective_answers],
                "understandingSummary": understanding_summary,
            }
            run.userInputResponses.append({**decision_payload, "checkpointType": checkpoint_type})
            run.approvalResponses.append(compatibility_response)
            run.pendingApproval = None
            run.pendingUserInput = None
            if run.status == "waiting_user_input":
                run.status = "running"
            await self._emit(
                run,
                "user_input_resolved",
                step_id=request.stepId,
                status="completed",
                payload={
                    "requestId": request_id,
                    "answers": decision_payload["answers"],
                    "effectiveAnswers": decision_payload["effectiveAnswers"],
                    "understandingSummary": understanding_summary,
                },
            )
            plan = self.state.plans.get(run.planId)
            if plan is not None:
                run.deadlineAt = self._run_deadline_at(
                    plan,
                    {},
                    {},
                    step_ids={run.currentStepId} if run.currentStepId else None,
                )
            self._save()
            resume_task = asyncio.create_task(self._run_graph_guarded(run_id, resume=compatibility_response))
            self._run_tasks[run_id] = resume_task
            resolution = AgentUserInputResolution(
                requestId=request_id,
                inputSessionId=request.inputSessionId,
                round=request.round,
                phase="execution",
                answers=answers,
                effectiveAnswers=effective_answers,
                understandingSummary=understanding_summary,
                nextAction="run_resumed",
                request=request,
                run=run.model_dump(),
            )
        self.state.pendingUserInputs.pop(request_id, None)
        self.state.userInputResolutions[request_id] = resolution.model_dump()
        self._save()
        return resolution

    async def dismiss_user_input(self, params: dict[str, Any], context: dict[str, Any]) -> AgentUserInputResolution:
        request_id = str(params.get("requestId") or "")
        if not request_id:
            raise ValueError("requestId is required")
        lock = self._user_input_locks.setdefault(request_id, asyncio.Lock())
        async with lock:
            resolved_payload = self.state.userInputResolutions.get(request_id)
            if resolved_payload:
                return AgentUserInputResolution.model_validate(resolved_payload)
            pending_entry = self.state.pendingUserInputs.get(request_id)
            if not pending_entry:
                raise ValueError("User input request is no longer pending")
            request = AgentUserInputRequest.model_validate(pending_entry.get("request"))
            if params.get("conversationId") and str(params.get("conversationId")) != request.conversationId:
                raise ValueError("conversationId does not match pending user input")
            run_payload: dict[str, Any] | None = None
            if request.phase == "execution":
                run = self.state.runs.get(str(request.runId or ""))
                if not run or not run.pendingUserInput or run.pendingUserInput.requestId != request_id:
                    raise ValueError("Run no longer waits for this user input request")
                run = await self.cancel({"runId": run.runId})
                run_payload = run.model_dump()
                next_action = "run_cancelled"
            else:
                self.state.pendingUserInputs.pop(request_id, None)
                next_action = "returned_to_chat"
            resolution = AgentUserInputResolution(
                requestId=request_id,
                inputSessionId=request.inputSessionId,
                round=request.round,
                phase=request.phase,
                status="dismissed",
                answers=[],
                effectiveAnswers=[],
                understandingSummary="用户关闭了本轮问题，未提交回答。",
                nextAction=next_action,
                request=request,
                run=run_payload,
            )
            self.state.pendingUserInputs.pop(request_id, None)
            self.state.userInputResolutions[request_id] = resolution.model_dump()
            self._save()
            return resolution

    async def submit_approval(self, params: dict[str, Any]) -> AgentRun:
        run_id = str(params.get("runId") or "")
        checkpoint_id = str(params.get("checkpointId") or "")
        run = self.state.runs.get(run_id)
        if not run:
            raise ValueError("runId not found")
        if run.pendingUserInput:
            request = run.pendingUserInput
            selected_option_ids = [str(item) for item in (params.get("selectedOptionIds") or [])]
            free_text = str(params.get("freeText") or "").strip()
            if len(request.questions) != 1:
                raise ValueError("Legacy approval submission cannot answer multiple questions")
            question = request.questions[0]
            answer = (
                {"questionId": question.questionId, "answerKind": "custom", "customText": free_text}
                if free_text
                else {"questionId": question.questionId, "answerKind": "option", "selectedOptionId": selected_option_ids[0] if selected_option_ids else ""}
            )
            await self.submit_user_input({
                "requestId": request.requestId,
                "conversationId": request.conversationId,
                "answers": [answer],
            }, {})
            return run
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
        if response["checkpointType"] == "chapter_beats":
            response.update({
                "draftBatchId": str(pending.get("draftBatchId") or ""),
                "outlineRevision": int(pending.get("outlineRevision") or 0),
            })
            if response["selectedOptionIds"] and response["freeText"]:
                raise ValueError("Chapter beats require either approval or revision instructions, not both")
            if response["selectedOptionIds"] and response["selectedOptionIds"] != ["approve_beats"]:
                raise ValueError("Chapter beats only support approve_beats")
            if len(response["freeText"]) > 4000:
                raise ValueError("Chapter beat revision instructions must be 4000 characters or fewer")
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
        plan = self.state.plans.get(run.planId)
        if plan is not None:
            run.deadlineAt = self._run_deadline_at(
                plan,
                {},
                {},
                step_ids={run.currentStepId} if run.currentStepId else None,
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
            if any(artifact.status in {"ready", "committed"} for artifact in run.artifacts):
                run.completionKind = "partial"
            payload = {**payload, "failureRevision": run.failureRevision}
        payload = {
            **payload,
            "completionKind": run.completionKind,
            **({"recovery": run.recovery.model_dump()} if run.recovery else {}),
        }
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
            if "rag.ask" in goal.lower() and "search.query" in goal.lower():
                return await self._tool_invoke(
                    run,
                    "rag.ask",
                    {
                        "novelId": novel_id,
                        "chapterId": chapter_id,
                        "question": goal.split("\n\n会话背景（仅用于理解当前任务）：\n", 1)[0].strip(),
                        "analysisScope": "novel",
                        "locale": locale,
                        "maxEvidenceItems": 20,
                    },
                )
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
            keyword_match = re.search(
                r"search\.query[^。；;\n]{0,40}?(?:查找|查询|搜索|检索|查)\s*[\"“「']?([^\s，。；;”\"」]{1,80})",
                goal,
                re.IGNORECASE,
            )
            return await self._tool_invoke(run, tool_name, {
                "novelId": novel_id,
                "keyword": keyword_match.group(1) if keyword_match else goal,
            })
        if tool_name in {"plotline.list", "character.list", "item.list", "worldsetting.list", "map.list"}:
            return await self._tool_invoke(run, tool_name, {"novelId": novel_id})
        raise ValueError(f"Unsupported Agent tool mapping: {tool_name}")

    async def _tool_invoke(self, run: AgentRun, method: str, params: dict[str, Any]) -> Any:
        normalized_params = normalize_tool_arguments(params)
        if method == "chapter.generate_draft":
            return await self._durable_chapter_draft_invoke(run, normalized_params)
        definition = AGENT_TOOL_BY_NAME.get(method)
        if definition and not definition.read_only:
            return await self._side_effect_tool_invoke(run, method, normalized_params)

        async def invoke_adapter(request_id: str) -> Any:
            try:
                return await self.tool_adapter.invoke(
                    method,
                    normalized_params,
                    "desktop-ui",
                    request_id=request_id,
                    deadline_at=run.deadlineAt,
                )
            except TypeError as error:
                if "unexpected keyword argument" not in str(error):
                    raise
                return await self.tool_adapter.invoke(
                    method,
                    normalized_params,
                    "desktop-ui",
                    request_id=request_id,
                )

        return await self._retryable_request_invoke(
            run,
            method,
            invoke_adapter,
            node_id=method,
            tool_request=True,
        )

    async def _get_draft_operation_status(
        self,
        run: AgentRun,
        operation_id: str,
    ) -> dict[str, Any]:
        observed = await self._retryable_request_invoke(
            run,
            "chapter.draft.get_status",
            lambda request_id: self.tool_adapter.invoke(
                "chapter.draft.get_status",
                {"operationId": operation_id},
                "desktop-ui",
                request_id=request_id,
            ),
            node_id="chapter.draft.get_status",
            tool_request=True,
        )
        if not isinstance(observed, dict) or observed.get("operationId") != operation_id:
            raise DraftOperationFailed(
                "INVALID_OPERATION_STATUS",
                "后台草稿任务返回了无效状态。",
                operation_id,
            )
        return observed

    async def _record_draft_operation_progress(
        self,
        run: AgentRun,
        operation_id: str,
        observed: dict[str, Any],
    ) -> tuple[str, int]:
        operation_status = str(observed.get("status") or "")
        operation_version = int(observed.get("version") or run.draftOperationVersion or 1)
        if operation_status != run.draftOperationStatus or operation_version != run.draftOperationVersion:
            run.draftOperationStatus = operation_status
            run.draftOperationVersion = operation_version
            self._save()
            await self._emit(
                run,
                "draft_operation_progress",
                step_id=run.currentStepId,
                agent="writer",
                tool_name="chapter.generate_draft",
                status=(
                    "completed" if operation_status == "succeeded"
                    else "failed" if operation_status in {"definitive_failed", "reconcile_required"}
                    else "cancelled" if operation_status == "cancelled"
                    else "running"
                ),
                payload={
                    "operationId": operation_id,
                    "operationStatus": operation_status,
                    "phase": observed.get("phase"),
                    "operationVersion": operation_version,
                    "attempt": observed.get("attempt"),
                    "maxAttempts": observed.get("maxAttempts"),
                    "progress": observed.get("progress"),
                    "retryAt": observed.get("retryAt"),
                },
            )
        return operation_status, operation_version

    async def _durable_chapter_draft_invoke(self, run: AgentRun, params: dict[str, Any]) -> Any:
        operation_key, params_hash = build_durable_operation_key(
            run.planId,
            run.currentStepId,
            "chapter.generate_draft",
            params,
        )
        record = self.store.prepare_invocation(
            ToolInvocationRecord(
                invocationKey=operation_key,
                requestId=new_id("automation"),
                runId=run.runId,
                stepId=run.currentStepId,
                method="chapter.generate_draft",
                paramsHash=params_hash,
                sideEffect=True,
                status="prepared",
            )
        )
        if record.paramsHash != params_hash or record.method != "chapter.generate_draft":
            raise DraftOperationFailed(
                "IDEMPOTENCY_CONFLICT",
                "草稿任务的幂等键与请求参数不一致。",
                operation_key,
            )
        if record.status in {"succeeded", "reconciled_succeeded"}:
            return record.result
        if record.status in {"in_flight", "unknown"}:
            raise SideEffectResultUnknown("chapter.generate_draft", operation_key)
        if record.status in {"failed", "reconciled_absent"}:
            code = str((record.error or {}).get("code") or "DRAFT_OPERATION_FAILED")
            message = str((record.error or {}).get("message") or "章节草稿任务此前已明确失败。")
            raise DraftOperationFailed(code, message, str((record.result or {}).get("operationId") or operation_key))

        run.draftOperationKey = operation_key
        self._save()
        operation: dict[str, Any]
        if record.status == "prepared":
            operation_deadline = self._earliest_deadline(
                run.deadlineAt,
                (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
            )
            start_params = {
                "operationKey": operation_key,
                "generationRevision": int(params.get("generationRevision") or 1),
                "operationDeadlineAt": operation_deadline,
                "maxAttempts": 4,
                "owner": {
                    "conversationId": run.threadId,
                    "runId": run.runId,
                    "stepId": run.currentStepId,
                },
                "payload": params,
            }
            started = await self._retryable_request_invoke(
                run,
                "chapter.draft.start",
                lambda request_id: self.tool_adapter.invoke(
                    "chapter.draft.start",
                    start_params,
                    "desktop-ui",
                    request_id=request_id,
                    deadline_at=operation_deadline,
                ),
                node_id="chapter.draft.start",
                tool_request=True,
            )
            if not isinstance(started, dict) or not str(started.get("operationId") or "").strip():
                raise DraftOperationFailed(
                    "INVALID_OPERATION_RECEIPT",
                    "后台草稿任务未返回 operationId。",
                    operation_key,
                )
            operation = dict(started)
            record = self.store.mark_invocation_operation_pending(operation_key, operation)
        else:
            if not isinstance(record.result, dict):
                raise DraftOperationFailed(
                    "INVALID_OPERATION_RECEIPT",
                    "后台草稿任务的持久化回执无效。",
                    operation_key,
                )
            operation = dict(record.result)

        operation_id = str(operation.get("operationId") or "").strip()
        if not operation_id:
            raise DraftOperationFailed(
                "INVALID_OPERATION_RECEIPT",
                "后台草稿任务的持久化回执缺少 operationId。",
                operation_key,
            )
        is_new_binding = run.draftOperationId != operation_id
        run.draftOperationId = operation_id
        if is_new_binding or not run.draftOperationStatus:
            run.draftOperationStatus = str(operation.get("status") or "queued")
            run.draftOperationVersion = int(operation.get("version") or 1)
        self._save()
        if is_new_binding:
            await self._emit(
                run,
                "draft_operation_started",
                step_id=run.currentStepId,
                agent="writer",
                tool_name="chapter.generate_draft",
                status="running",
                payload={
                    "operationId": operation_id,
                    "operationKey": operation_key,
                    "operationStatus": run.draftOperationStatus,
                    "operationVersion": run.draftOperationVersion,
                    "attempt": operation.get("attempt"),
                    "maxAttempts": operation.get("maxAttempts"),
                },
            )

        poll_after_ms = int(operation.get("pollAfterMs") or 1000)
        poll_after_seconds = max(0.25, min(5.0, poll_after_ms / 1000))
        try:
            observed = await self._get_draft_operation_status(run, operation_id)
            operation_status, operation_version = await self._record_draft_operation_progress(
                run,
                operation_id,
                observed,
            )
            if operation_status == "succeeded":
                result_ref = observed.get("result")
                draft_session_id = str(
                    result_ref.get("draftSessionId")
                    if isinstance(result_ref, dict)
                    else ""
                ).strip()
                if not draft_session_id:
                    raise DraftOperationFailed(
                        "INVALID_OPERATION_RESULT",
                        "后台草稿任务成功，但没有返回 draftSessionId。",
                        operation_id,
                    )
                result = await self._tool_invoke(
                    run,
                    "draft.get",
                    {"draftSessionId": draft_session_id},
                )
                self.store.mark_invocation_succeeded(
                    operation_key,
                    self._side_effect_result_snapshot(result),
                )
                return result
            if operation_status == "cancelled":
                self.store.mark_invocation_failed(
                    operation_key,
                    {"code": "CANCELLED", "message": "后台草稿任务已取消。", "operationId": operation_id},
                )
                raise asyncio.CancelledError
            if operation_status == "reconcile_required":
                error = observed.get("error") if isinstance(observed.get("error"), dict) else {}
                self.store.mark_invocation_unknown(
                    operation_key,
                    {
                        "code": str(error.get("code") or "RECONCILIATION_REQUIRED"),
                        "message": str(error.get("userMessage") or "后台草稿任务需要人工核对。"),
                        "operationId": operation_id,
                    },
                )
                raise SideEffectResultUnknown(
                    "chapter.generate_draft",
                    operation_key,
                    "The durable draft operation requires reconciliation before it can continue.",
                )
            if operation_status == "definitive_failed":
                error = observed.get("error") if isinstance(observed.get("error"), dict) else {}
                code = str(error.get("code") or "DRAFT_OPERATION_FAILED")
                message = str(error.get("userMessage") or "后台草稿任务已明确失败。")
                details = error.get("details") if isinstance(error.get("details"), dict) else {}
                self.store.mark_invocation_failed(
                    operation_key,
                    {"code": code, "message": message, "operationId": operation_id, **details},
                )
                raise DraftOperationFailed(code, message, operation_id, details)
            if operation_status not in {
                "queued",
                "running_generation",
                "retry_wait",
                "running_postprocess",
                "committing",
                "cancel_requested",
            }:
                raise DraftOperationFailed(
                    "INVALID_OPERATION_STATUS",
                    f"后台草稿任务返回未知状态：{operation_status or 'empty'}。",
                    operation_id,
                )
            observed_poll_after_ms = observed.get("pollAfterMs")
            if isinstance(observed_poll_after_ms, (int, float)):
                poll_after_seconds = max(0.25, min(5.0, float(observed_poll_after_ms) / 1000))
            raise DraftOperationPending(
                operation_id,
                operation_key,
                operation_status,
                operation_version,
                poll_after_seconds,
            )
        except asyncio.CancelledError:
            try:
                await asyncio.shield(self._cancel_draft_operation(operation_id))
            except Exception:
                pass
            raise

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
            result = await self.tool_adapter.invoke(
                method,
                params,
                "desktop-ui",
                request_id=request_id,
                deadline_at=run.deadlineAt,
            )
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
            details = getattr(error, "details", None)
            if isinstance(details, dict) and details.get("safeToRetryBeforePublish") is True:
                failure = {
                    "code": str(getattr(error, "code", "INVOCATION_ERROR")),
                    "message": str(error),
                    **{
                        key: details[key]
                        for key in (
                            "terminationReason",
                            "responseId",
                            "model",
                            "usage",
                            "requestedMaxTokens",
                            "attemptCount",
                            "attempts",
                            "safeToRetryBeforePublish",
                        )
                        if key in details
                    },
                }
                self.store.mark_invocation_failed(invocation_key, failure)
                raise
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

    @staticmethod
    def _validation_issues(error: ValidationError) -> list[dict[str, str]]:
        return [
            {
                "path": ".".join(str(part) for part in item.get("loc") or ()),
                "message": str(item.get("msg") or "Invalid value")[:1000],
            }
            for item in error.errors(include_url=False)[:20]
        ]

    @classmethod
    def _model_output_issues(cls, error: ValidationError | ToolchainError) -> list[dict[str, str]]:
        if isinstance(error, ValidationError):
            return cls._validation_issues(error)
        return [{"path": error.node_id or "", "message": str(error)[:1000]}]

    @staticmethod
    def _normalize_final_report(value: Any) -> dict[str, str]:
        if not isinstance(value, dict):
            raise ToolchainError(
                "NODE_FAILED",
                "Agent final report must be a JSON object",
                node_id="final_report",
            )
        content = str(value.get("content") or "").strip()
        if not content:
            raise ToolchainError(
                "NODE_FAILED",
                "Agent final report returned empty content",
                node_id="final_report",
            )
        return {
            "content": content,
            "conversationSummary": str(value.get("conversationSummary") or "").strip() or content,
        }

    def _classify_local_transform_failure(self, run: AgentRun, error: Exception) -> None:
        if run.recovery is not None or not isinstance(error, (AttributeError, KeyError, TypeError)):
            return
        latest_result = next((
            (node_id, result_ref)
            for (owner_id, node_id), result_ref in reversed(self._model_result_refs.items())
            if owner_id == run.runId and result_ref.get("modelResultRef")
        ), None)
        if latest_result is None:
            return
        node_id, result_ref = latest_result
        fingerprint_source = f"{type(error).__name__}|{node_id}|{str(error)}"
        failure_fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()
        diagnostic_ref = f"diagnostic_{failure_fingerprint[:16]}"
        run.recovery = AgentRecoveryDescriptor(
            failureKind="local_transform_failed",
            failedAtPhase="normalizing",
            retryStrategy="none",
            canRecover=False,
            recoveryRevision=run.failureRevision + 1,
            blockedReason="processor_update_required",
            completedArtifactIds=[
                artifact.artifactId for artifact in run.artifacts if artifact.status in {"ready", "committed"}
            ],
            diagnosticRef=diagnostic_ref,
        )
        self.state.recoveryRecords[run.runId] = {
            "nodeId": node_id,
            "sourceMethod": result_ref.get("sourceMethod"),
            "modelResultRef": result_ref.get("modelResultRef"),
            "processorVersion": self._STRUCTURED_OUTPUT_PROCESSOR_VERSION,
            "failureFingerprint": failure_fingerprint,
            "diagnosticRef": diagnostic_ref,
        }

    def _refresh_local_recovery_capability(self, run: AgentRun) -> bool:
        if not run.recovery or run.recovery.failureKind != "local_transform_failed":
            return False
        recovery_record = self.state.recoveryRecords.get(run.runId) or {}
        previous_version = str(recovery_record.get("processorVersion") or "")
        if (
            not recovery_record.get("modelResultRef")
            or not previous_version
            or previous_version == self._STRUCTURED_OUTPUT_PROCESSOR_VERSION
        ):
            return False
        run.recovery = run.recovery.model_copy(update={
            "retryStrategy": "reprocess_saved_result",
            "canRecover": True,
            "actionLabel": "继续处理已保存结果",
            "recoveryRevision": run.failureRevision,
            "blockedReason": None,
        })
        self._save()
        return True

    @staticmethod
    def _public_failure_message(run: AgentRun, error: Exception) -> str:
        if run.recovery and run.recovery.actionLabel == "重试审校" and run.draftSessionId:
            return f"正文已保存，审校未完成。可重试审校，无需重新生成正文。原因：{error}"
        if run.recovery and run.recovery.failureKind == "model_output_invalid":
            return "生成结果已保存，但格式检查未通过。可直接修复结果并继续。"
        if run.recovery and run.recovery.failureKind == "local_transform_failed":
            return "模型结果已保存，但本地处理程序未能完成转换。当前版本不会重复执行同一失败步骤。"
        return str(error)

    def _set_model_output_recovery(
        self,
        run: AgentRun,
        *,
        node_id: str,
        source_method: str,
        result_ref: dict[str, Any],
        validation_issues: list[dict[str, str]],
    ) -> AgentRecoveryDescriptor:
        diagnostic_payload = json.dumps({
            'runId': run.runId,
            'nodeId': node_id,
            'sourceMethod': source_method,
            'modelResultRef': result_ref.get('modelResultRef'),
            'issues': validation_issues,
        }, ensure_ascii=False, sort_keys=True)
        diagnostic_ref = f"diagnostic_{hashlib.sha256(diagnostic_payload.encode('utf-8')).hexdigest()[:16]}"
        recovery = AgentRecoveryDescriptor(
            failureKind="model_output_invalid",
            failedAtPhase="normalizing",
            retryStrategy="repair_model_output",
            canRecover=True,
            recoveryRevision=run.failureRevision + 1,
            actionLabel="修复结果并继续",
            completedArtifactIds=[artifact.artifactId for artifact in run.artifacts if artifact.status in {"ready", "committed"}],
            diagnosticRef=diagnostic_ref,
        )
        run.recovery = recovery
        self.state.recoveryRecords[run.runId] = {
            "nodeId": node_id,
            "sourceMethod": source_method,
            "modelResultRef": result_ref.get("modelResultRef"),
            "contractId": result_ref.get("contractId"),
            "contractVersion": result_ref.get("contractVersion"),
            "automaticRepairAttempts": 1,
            "validationIssues": validation_issues,
            "diagnosticRef": diagnostic_ref,
        }
        return recovery

    async def _normalize_model_output(
        self,
        run: AgentRun,
        *,
        node_id: str,
        source_method: str,
        raw_value: Any,
        normalizer: Callable[[Any], Any],
    ) -> Any:
        try:
            return normalizer(raw_value)
        except (ValidationError, ToolchainError) as error:
            result_key = (run.runId, node_id)
            result_ref = self._model_result_refs.get(result_key) or {
                "modelResultRef": "",
                "sourceMethod": source_method,
                "automaticRepairAttempts": 0,
            }
            issues = self._model_output_issues(error)
            if not result_ref.get("modelResultRef"):
                raise
            if int(result_ref.get("automaticRepairAttempts") or 0) < 1:
                repair_details = {**result_ref, "validationIssues": issues}
                try:
                    repaired = await self._repair_saved_structured_output(
                        run,
                        source_method=source_method,
                        node_id=node_id,
                        details=repair_details,
                        repair_attempt=1,
                    )
                    result_ref["automaticRepairAttempts"] = 1
                    self._model_result_refs[result_key] = result_ref
                    return normalizer(repaired)
                except (ValidationError, ToolchainError, AgentRequestError):
                    pass
            recovery = self._set_model_output_recovery(
                run,
                node_id=node_id,
                source_method=source_method,
                result_ref=result_ref,
                validation_issues=issues,
            )
            raise ToolchainError(
                "MODEL_OUTPUT_INVALID",
                "生成结果未能通过格式检查，自动修复未成功。",
                node_id=node_id,
                retryable=False,
                details={"recovery": recovery.model_dump()},
            ) from error

    async def _retryable_automation_invoke(
        self,
        run: AgentRun | None,
        method: str,
        params: dict[str, Any],
        *,
        node_id: str | None = None,
    ) -> Any:
        effective_node_id = node_id or method
        owner_id = run.runId if run else "request"
        pending_key = f"{owner_id}:{effective_node_id}"
        pending_result = self.state.pendingModelResults.pop(pending_key, None)
        if pending_result is not None:
            pending_repair_attempt = pending_result.get("repairAttempt")
            self._model_result_refs[(owner_id, effective_node_id)] = {
                "modelResultRef": pending_result.get("modelResultRef"),
                "sourceMethod": method,
                "automaticRepairAttempts": int(
                    pending_repair_attempt if pending_repair_attempt is not None else 1
                ),
            }
            self._save()
            return pending_result.get("payload")

        def remember_result(request_id: str, _result: Any) -> None:
            self._model_result_refs[(owner_id, effective_node_id)] = {
                "modelResultRef": request_id,
                "sourceMethod": method,
                "automaticRepairAttempts": 0,
            }

        async def invoke_automation(request_id: str) -> Any:
            return await self._invoke_automation_request(
                method,
                params,
                request_id=request_id,
                deadline_at=run.deadlineAt if run else None,
            )

        try:
            return await self._retryable_request_invoke(
                run,
                method,
                invoke_automation,
                node_id=effective_node_id,
                on_result=remember_result,
            )
        except AgentRequestError as error:
            if error.code != "MODEL_OUTPUT_INVALID":
                raise
            details = error.details if isinstance(error.details, dict) else {}
            try:
                repaired = await self._repair_saved_structured_output(
                    run,
                    source_method=method,
                    node_id=effective_node_id,
                    details=details,
                    repair_attempt=1,
                )
            except AgentRequestError as repair_error:
                if run is None:
                    raise
                recovery = self._set_model_output_recovery(
                    run,
                    node_id=effective_node_id,
                    source_method=method,
                    result_ref={**details, "automaticRepairAttempts": 1},
                    validation_issues=[
                        {"path": str(item.get("path") or ""), "message": str(item.get("message") or "")}
                        for item in (details.get("validationIssues") or [])
                        if isinstance(item, dict)
                    ],
                )
                raise ToolchainError(
                    "MODEL_OUTPUT_INVALID",
                    "生成结果未能通过格式检查，自动修复未成功。",
                    node_id=effective_node_id,
                    retryable=False,
                    details={"recovery": recovery.model_dump()},
                ) from repair_error
            self._model_result_refs[(owner_id, effective_node_id)] = {
                "modelResultRef": details.get("modelResultRef"),
                "sourceMethod": method,
                "contractId": details.get("contractId"),
                "contractVersion": details.get("contractVersion"),
                "automaticRepairAttempts": 1,
            }
            return repaired

    async def _repair_saved_structured_output(
        self,
        run: AgentRun | None,
        *,
        source_method: str,
        node_id: str,
        details: dict[str, Any],
        repair_attempt: int,
    ) -> Any:
        model_result_ref = str(details.get("modelResultRef") or "").strip()
        if not model_result_ref:
            raise AgentRequestError(AgentRequestFailure(
                code="MODEL_OUTPUT_INVALID",
                retryable=False,
                attempts=1,
                user_message="模型结构不符合要求，且保存的结果引用不可用。",
                diagnostic_ref=new_id("diagnostic"),
            ))
        repair_attempt_id = hashlib.sha256(
            f"{model_result_ref}|{source_method}|repair|{repair_attempt}".encode("utf-8")
        ).hexdigest()
        result = await self._retryable_request_invoke(
            run,
            "agent.repair_structured_output",
            lambda request_id: self._invoke_automation_request(
                "agent.repair_structured_output",
                {
                    "modelResultRef": model_result_ref,
                    "sourceMethod": source_method,
                    **({"contractId": details.get("contractId")} if details.get("contractId") else {}),
                    **({"contractVersion": details.get("contractVersion")} if details.get("contractVersion") else {}),
                    "validationIssues": details.get("validationIssues") or [],
                    "repairAttemptId": repair_attempt_id,
                    "repairAttempt": repair_attempt,
                },
                request_id=request_id,
                deadline_at=run.deadlineAt if run else None,
            ),
            node_id=f"{node_id}.repair.{repair_attempt}",
        )
        if not isinstance(result, dict) or not isinstance(result.get("repairedPayload"), dict):
            raise AgentRequestError(AgentRequestFailure(
                code="MODEL_OUTPUT_INVALID",
                retryable=False,
                attempts=1,
                user_message="模型未能修复结构化结果。",
                diagnostic_ref=new_id("diagnostic"),
                details={
                    "modelResultRef": model_result_ref,
                    "contractId": details.get("contractId"),
                    "contractVersion": details.get("contractVersion"),
                },
            ))
        return result["repairedPayload"]

    async def _reprocess_saved_structured_output(
        self,
        *,
        source_method: str,
        node_id: str,
        details: dict[str, Any],
    ) -> Any:
        model_result_ref = str(details.get("modelResultRef") or "").strip()
        if not model_result_ref:
            raise ValueError("Saved model result reference is unavailable")
        result = await self._retryable_request_invoke(
            None,
            "agent.reprocess_saved_structured_output",
            lambda request_id: self.automation.invoke(
                "agent.reprocess_saved_structured_output",
                {
                    "modelResultRef": model_result_ref,
                    "sourceMethod": source_method,
                },
                "desktop-ui",
                request_id=request_id,
            ),
            node_id=f"{node_id}.reprocess",
        )
        if not isinstance(result, dict) or not isinstance(result.get("payload"), dict):
            raise ValueError("Saved model result reprocessing returned an invalid payload")
        return result["payload"]

    async def _retryable_request_invoke(
        self,
        run: AgentRun | None,
        method: str,
        invoke: Callable[[str], Awaitable[Any]],
        *,
        node_id: str,
        tool_request: bool = False,
        on_result: Callable[[str, Any], None] | None = None,
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

        result = await self.request_graph.run(
            request_call,
            operation_id=operation_id,
            request_id=request_id,
            node_id=node_id,
            method=method,
            on_event=on_event if run else None,
        )
        if on_result:
            on_result(request_id, result)
        return result

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
                "draftType", "previewSummary", "artifactId", "version", "generationCompleted",
                "editorialReviewCompleted", "editorialRevisionCompleted", "reviewArtifactId",
                "reviewSummary", "warningScope",
            }
            for key, value in result.items():
                if key in preferred_keys and value is not None:
                    compact[str(key)] = self._compact_report_result(value, depth + 1)
                if len(compact) >= 32:
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
