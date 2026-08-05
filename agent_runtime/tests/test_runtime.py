from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from novel_agent_runtime.automation import AutomationInvokeError
from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.main import build_app
from novel_agent_runtime.roles import list_agent_roles
from novel_agent_runtime.retry import AgentRequestError
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.schemas import AgentEvidenceSnapshot, AgentRun, AgentRunEvent, new_id
from novel_agent_runtime.store import AgentStateStore
from novel_agent_runtime.tool_adapter import FastMcpAgentToolAdapter
from novel_agent_runtime.tool_manifest import AVAILABLE_AGENT_TOOLS


class FakeAutomationClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str]] = []
        self.request_ids: list[str] = []
        self.cancelled_request_ids: list[str] = []

    async def invoke(
        self,
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
    ) -> Any:
        self.calls.append((method, params, origin))
        if request_id:
            self.request_ids.append(request_id)
        if method == "agent.generate_chat":
            return {"content": "我会分析这一章的冲突目标。", "shouldPlan": True, "needsClarification": False}
        if method == "agent.generate_plan":
            return {
                "title": "章节续写计划",
                "steps": [
                    {"agent": "supervisor", "title": "读取当前章节上下文", "tools": ["chapter.get"]},
                    {"agent": "writer", "title": "生成续写草稿", "tools": ["chapter.generate_draft"]},
                ],
            }
        if method == "agent.generate_user_input_followup":
            return {"needsFollowUp": False}
        if method == "agent.summarize_user_input":
            return {"summary": params.get("fallbackSummary") or "已记录用户决定。"}
        if method == "agent.revise_plan":
            first_step = params["currentPlan"]["steps"][0]
            return {
                "title": "章节续写与读者检查计划",
                "steps": [
                    {
                        "stepId": first_step["stepId"],
                        "agent": first_step["agent"],
                        "title": first_step["title"],
                        "tools": first_step["tools"],
                    },
                    {"agent": "reader", "title": "检查追更欲望", "tools": ["rag.ask"]},
                ],
            }
        if method == "agent.generate_report":
            return {
                "content": "## 最终建议\n\n冲突出现偏晚，建议提前设置明确阻力，并在章末留下未解决的问题。",
                "conversationSummary": "审阅已完成。核心问题是冲突出现偏晚；建议前置明确阻力，并在章末保留悬念。完整分析已保存在产物中。",
            }
        if method == "agent.detect_creative_direction":
            return {"requiresDecision": False}
        if method == "chapter.get":
            return {"id": params["chapterId"], "title": "第三章"}
        if method == "chapter.generate_draft":
            return {"draftSessionId": "draft_1", "type": "chapter-draft"}
        if method == "draft.get":
            if str(params["draftSessionId"]).startswith("creative"):
                return {
                    "draftSessionId": params["draftSessionId"],
                    "type": "creative-assets",
                    "status": "draft",
                    "version": 2,
                }
            return {
                "draftSessionId": params["draftSessionId"],
                "type": "chapter-draft",
                "status": "draft",
                "version": 2,
            }
        if method == "chapter.revise_draft":
            return {
                "draftSessionId": "draft_revision_1",
                "type": "chapter-draft",
                "status": "draft",
                "previewSummary": "根据审批意见生成的新版本",
            }
        if method == "creative_assets.revise_draft":
            return {
                "draftSessionId": "creative_revision_1",
                "type": "creative-assets",
                "status": "draft",
                "previewSummary": "角色 1，情节线 1",
            }
        if method == "creative_assets.generate_draft":
            return {"draftSessionId": "creative_draft_1", "type": "creative-assets"}
        if method == "rag.ask":
            return {"answer": "analysis complete"}
        return {"ok": True}

    async def cancel(self, request_id: str) -> bool:
        self.cancelled_request_ids.append(request_id)
        return True


def install_durable_draft_protocol(
    automation: FakeAutomationClient,
    *,
    pending_status_observations: int = 0,
) -> dict[str, Any]:
    """Wrap a semantic draft fake with the production durable transport contract."""
    original_invoke = automation.invoke
    operations: dict[str, dict[str, Any]] = {}
    status_observations: dict[str, int] = {}

    def record(method: str, params: dict[str, Any], origin: str, request_id: str | None) -> None:
        automation.calls.append((method, params, origin))
        if request_id:
            automation.request_ids.append(request_id)

    async def execute(operation_id: str, payload: dict[str, Any], origin: str) -> None:
        operation = operations[operation_id]
        operation["status"] = "running_generation"
        operation["version"] = 2
        try:
            result = await original_invoke("chapter.generate_draft", payload, origin)
        except asyncio.CancelledError:
            operation["status"] = "cancelled"
            operation["version"] += 1
        except AutomationInvokeError as error:
            operation["status"] = "definitive_failed"
            operation["version"] += 1
            operation["error"] = {"code": error.code, "userMessage": error.message}
        except Exception as error:  # noqa: BLE001 - the fake models an operation failure boundary
            operation["status"] = "definitive_failed"
            operation["version"] += 1
            operation["error"] = {"code": "DRAFT_GENERATION_FAILED", "userMessage": str(error)}
        else:
            draft_session_id = str(result.get("draftSessionId") if isinstance(result, dict) else "")
            if not draft_session_id:
                operation["status"] = "definitive_failed"
                operation["error"] = {
                    "code": "INVALID_OPERATION_RESULT",
                    "userMessage": "Fake draft operation did not produce draftSessionId",
                }
            else:
                operation["status"] = "succeeded"
                operation["result"] = result
            operation["version"] += 1

    async def invoke(
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
        **_: Any,
    ) -> Any:
        if method == "chapter.draft.start":
            record(method, params, origin, request_id)
            operation_id = f"operation_{len(operations) + 1}"
            operation = {
                "operationId": operation_id,
                "operationKey": params["operationKey"],
                "status": "queued",
                "phase": "accepted",
                "version": 1,
                "attempt": 0,
                "maxAttempts": params.get("maxAttempts", 4),
                "pollAfterMs": 1,
            }
            operations[operation_id] = operation
            operation["task"] = asyncio.create_task(execute(operation_id, params["payload"], origin))
            await asyncio.sleep(0)
            return {key: value for key, value in operation.items() if key not in {"task", "result"}}
        if method == "chapter.draft.get_status":
            record(method, params, origin, request_id)
            await asyncio.sleep(0)
            operation = operations[params["operationId"]]
            operation_id = str(params["operationId"])
            status_observations[operation_id] = status_observations.get(operation_id, 0) + 1
            if status_observations[operation_id] <= pending_status_observations:
                return {
                    "operationId": operation_id,
                    "operationKey": operation["operationKey"],
                    "status": "running_generation",
                    "phase": "generation",
                    "version": max(2, int(operation["version"])),
                    "attempt": 1,
                    "maxAttempts": operation["maxAttempts"],
                    "pollAfterMs": 1,
                }
            response = {key: value for key, value in operation.items() if key not in {"task", "result"}}
            if operation.get("status") == "succeeded":
                result = operation["result"]
                response["result"] = {
                    "draftSessionId": result["draftSessionId"],
                    "generationRevision": result.get("generationRevision", 1),
                }
            return response
        if method == "chapter.draft.cancel":
            record(method, params, origin, request_id)
            operation = operations[params["operationId"]]
            task = operation.get("task")
            if isinstance(task, asyncio.Task) and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            operation["status"] = "cancelled"
            operation["version"] += 1
            return {key: value for key, value in operation.items() if key not in {"task", "result"}}
        if method == "draft.get":
            for operation in operations.values():
                result = operation.get("result")
                if isinstance(result, dict) and result.get("draftSessionId") == params.get("draftSessionId"):
                    record(method, params, origin, request_id)
                    return result
        return await original_invoke(method, params, origin, request_id=request_id)

    automation.invoke = invoke  # type: ignore[method-assign]
    return {"operations": operations, "statusObservations": status_observations}


def create_runtime(state_dir: Path) -> tuple[NovelAgentRuntime, FakeAutomationClient]:
    store = AgentStateStore(state_dir)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
    return runtime, automation


def test_chapter_list_forwards_paging_and_explicit_false(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        await runtime._invoke_exploration_tool(
            "chapter.list",
            {"volumeId": "volume-1", "offset": 0, "limit": 20, "includeContent": False},
            "列出章节",
            {"novelId": "novel-1", "volumeId": "volume-1", "chapterId": ""},
            "zh-CN",
        )
        method, params, _ = automation.calls[-1]
        assert method == "chapter.list"
        assert params == {"volumeId": "volume-1", "offset": 0, "limit": 20, "includeContent": False}

    asyncio.run(scenario())


def test_retry_chat_summary_uses_only_persisted_evidence(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        snapshot = AgentEvidenceSnapshot(
            conversationId="conversation-summary-retry",
            requestId="request-original",
            sourceMessageId="message-original",
            message="感受这两章",
            role="reader",
            locale="zh-CN",
            chapterScope={"kind": "selected_chapters", "chapterIds": ["chapter-1", "chapter-2"]},
            chapters=[
                {"chapterId": "chapter-1", "result": {"title": "第一章", "content": "正文一"}, "ok": True},
                {"chapterId": "chapter-2", "result": {"title": "第二章", "content": "正文二"}, "ok": True},
            ],
            contextReads=[
                {"toolName": "chapter.get", "status": "completed", "callId": "call-read-1"},
                {"toolName": "chapter.get", "status": "completed", "callId": "call-read-2"},
            ],
        )
        runtime.state.evidenceSnapshots[snapshot.evidenceSnapshotId] = snapshot

        async def retry_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            assert params["availableReadTools"] == []
            assert params["messageId"] == "message-original"
            assert params["availableReadToolDefinitions"] == []
            assert [item["args"]["chapterId"] for item in params["toolObservations"]] == ["chapter-1", "chapter-2"]
            return {"content": "基于原请求快照生成的两章总结。", "toolCalls": []}

        automation.invoke = retry_invoke  # type: ignore[method-assign]
        response = await runtime.retry_chat_summary(
            {"evidenceSnapshotId": snapshot.evidenceSnapshotId},
            {"_requestId": "request-retry"},
        )
        assert response.status == "completed"
        assert response.evidenceSnapshotId == snapshot.evidenceSnapshotId
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat"]
        restored = AgentStateStore(tmp_path).load()
        assert restored.evidenceSnapshots[snapshot.evidenceSnapshotId].message == "感受这两章"

    asyncio.run(scenario())


def test_recover_chat_reprocesses_saved_payload_without_generating_again(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def recover_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
            **_: Any,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.reprocess_saved_structured_output"
            assert params == {
                "modelResultRef": "saved-chat-result",
                "sourceMethod": "agent.generate_chat",
            }
            return {
                "payload": {
                    "content": "这是从已保存结果恢复的普通对话回答。",
                    "shouldPlan": False,
                    "requestedOperations": [],
                    "toolCalls": [],
                    "inputRequest": None,
                }
            }

        automation.invoke = recover_invoke  # type: ignore[method-assign]
        runtime.state.recoveryRecords["chat-recovery-local"] = {
            "kind": "chat_model_output",
            "status": "available",
            "conversationId": "conversation-recover-local",
            "storageConversationId": "conversation-recover-local",
            "messageId": "message-recover-local",
            "modelResultRef": "saved-chat-result",
            "sourceMethod": "agent.generate_chat",
            "contractId": "agent.chat.response",
            "contractVersion": "1.0.0",
        }
        response = await runtime.recover_chat({
            "message": "推荐一个公众号连载题材",
            "messageId": "message-recover-local",
            "conversationId": "conversation-recover-local",
            "storageConversationId": "conversation-recover-local",
            "recovery": {
                "recoveryRef": "chat-recovery-local",
            },
        }, {"_requestId": "request-recover-local"})

        assert response.status == "completed"
        assert response.assistantMessage.content == "这是从已保存结果恢复的普通对话回答。"
        assert [method for method, _, _ in automation.calls] == ["agent.reprocess_saved_structured_output"]

    asyncio.run(scenario())


def test_chat_persists_backend_recovery_and_returns_only_opaque_reference(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def invalid_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
            **_: Any,
        ) -> Any:
            automation.calls.append((method, params, origin))
            raise AutomationInvokeError(
                "MODEL_OUTPUT_INVALID",
                "automatic repair failed",
                {
                    "modelResultRef": "private-model-result-ref",
                    "contractId": "agent.chat.response",
                    "contractVersion": "1.0.0",
                    "validationIssues": [{"path": "$.inputRequest", "message": "invalid"}],
                },
            )

        automation.invoke = invalid_invoke  # type: ignore[method-assign]
        with pytest.raises(AgentRequestError) as captured:
            await runtime.chat({
                "message": "推荐一个公众号连载题材",
                "messageId": "message-invalid-chat",
                "conversationId": "conversation-invalid-chat",
                "storageConversationId": "conversation-invalid-chat",
            }, {"_requestId": "request-invalid-chat"})

        assert captured.value.code == "MODEL_OUTPUT_INVALID"
        assert "recoveryRef" in captured.value.details
        assert "modelResultRef" not in captured.value.details
        recovery_ref = str(captured.value.details["recoveryRef"])
        record = runtime.state.recoveryRecords[recovery_ref]
        assert record["modelResultRef"] == "private-model-result-ref"
        assert record["conversationId"] == "conversation-invalid-chat"
        assert record["storageConversationId"] == "conversation-invalid-chat"
        restored = AgentStateStore(tmp_path).load()
        assert restored.recoveryRecords[recovery_ref]["messageId"] == "message-invalid-chat"

    asyncio.run(scenario())


def test_recover_chat_repairs_json_once_when_local_reprocess_is_still_invalid(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def recover_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
            **_: Any,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.reprocess_saved_structured_output":
                raise AutomationInvokeError(
                    "MODEL_OUTPUT_INVALID",
                    "saved output remains invalid",
                    {"modelResultRef": "saved-invalid-chat-result"},
                )
            assert method == "agent.repair_structured_output"
            assert params["repairAttempt"] == 2
            assert params["sourceMethod"] == "agent.generate_chat"
            return {
                "repairedPayload": {
                    "content": "这是第二次 JSON 修复后继续得到的回答。",
                    "shouldPlan": False,
                    "requestedOperations": [],
                    "toolCalls": [],
                    "inputRequest": None,
                }
            }

        automation.invoke = recover_invoke  # type: ignore[method-assign]
        runtime.state.recoveryRecords["chat-recovery-repair"] = {
            "kind": "chat_model_output",
            "status": "available",
            "conversationId": "conversation-recover-repair",
            "storageConversationId": "conversation-recover-repair",
            "messageId": "message-recover-repair",
            "modelResultRef": "saved-invalid-chat-result",
            "sourceMethod": "agent.generate_chat",
            "contractId": "agent.chat.response",
            "contractVersion": "1.0.0",
            "validationIssues": [{"path": "$.inputRequest", "message": "Expected object or null"}],
        }
        response = await runtime.recover_chat({
            "message": "推荐一个公众号连载题材",
            "messageId": "message-recover-repair",
            "conversationId": "conversation-recover-repair",
            "storageConversationId": "conversation-recover-repair",
            "recovery": {
                "recoveryRef": "chat-recovery-repair",
            },
        }, {"_requestId": "request-recover-repair"})

        assert response.status == "completed"
        assert response.assistantMessage.content == "这是第二次 JSON 修复后继续得到的回答。"
        assert [method for method, _, _ in automation.calls] == [
            "agent.reprocess_saved_structured_output",
            "agent.repair_structured_output",
        ]

    asyncio.run(scenario())


def test_explicit_scope_summary_timeout_preserves_evidence_for_manual_retry(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def timeout_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            if method == "chapter.scope_context.build":
                assert params["chapterIds"] == ["chapter-1", "chapter-2"]
                return {
                    "chapters": [
                        {"chapterId": "chapter-1", "title": "第一章", "content": "正文一", "contentHash": "hash-1"},
                        {"chapterId": "chapter-2", "title": "第二章", "content": "正文二", "contentHash": "hash-2"},
                    ],
                    "sourceSnapshot": [
                        {"chapterId": "chapter-1", "version": 1, "contentHash": "hash-1", "updatedAt": "2026-07-28T00:00:00Z"},
                        {"chapterId": "chapter-2", "version": 2, "contentHash": "hash-2", "updatedAt": "2026-07-28T00:00:01Z"},
                    ],
                }
            if method == "agent.generate_chat":
                if not params["toolObservations"]:
                    assert "currentContent" not in params["selectionContext"]
                    return {
                        "content": "我先读取这两章再回答。",
                        "shouldPlan": False,
                        "toolCalls": [{"name": "chapter.scope_context.build", "args": {"chapterIds": ["wrong"]}}],
                    }
                raise AutomationInvokeError("UPSTREAM_TIMEOUT", "summary timeout")
            raise AssertionError(method)

        automation.invoke = timeout_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "感受这两章",
                "role": "reader",
                "conversationId": "conversation-timeout",
                "chapterScope": {
                    "kind": "selected_chapters",
                    "chapterIds": ["chapter-1", "chapter-2"],
                    "processingMode": "detailed",
                },
            },
            {"novelId": "novel-1"},
        )
        assert response.status == "failed"
        assert response.failure and response.failure["code"] == "MODEL_SUMMARY_TIMEOUT"
        assert response.failure["coverage"] == {"completed": 2, "total": 2}
        assert response.evidenceSnapshotId in runtime.state.evidenceSnapshots
        assert [method for method, _, _ in automation.calls].count("agent.generate_chat") == 2
        assert [method for method, _, _ in automation.calls].count("chapter.scope_context.build") == 1

    asyncio.run(scenario())


def test_scope_conflict_stops_before_model_and_tools(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        response = await runtime.chat(
            {
                "message": "感受这两章",
                "role": "reader",
                "conversationId": "conversation-scope-conflict",
                "chapterScope": {
                    "kind": "selected_chapters",
                    "chapterIds": ["chapter-1"],
                    "processingMode": "detailed",
                },
            },
            {"novelId": "novel-1"},
        )
        assert response.status == "failed"
        assert response.failure and response.failure["code"] == "SCOPE_CONFLICT"
        assert automation.calls == []

    asyncio.run(scenario())


def test_chat_response_contains_paired_tool_lifecycle_events(tmp_path: Path) -> None:
    runtime, automation = create_runtime(tmp_path)

    async def activity_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
        automation.calls.append((method, params, origin))
        if method == "agent.generate_chat":
            if not params["toolObservations"]:
                return {
                    "content": "我先读取所选章节。",
                    "shouldPlan": False,
                    "toolCalls": [{"name": "chapter.scope_context.build", "args": {}}],
                }
            return {"content": "两章阅读反馈。", "shouldPlan": False, "toolCalls": []}
        if method == "chapter.scope_context.build":
            return {"chapters": [
                {"chapterId": "chapter-1", "title": "第一章", "content": "正文一"},
                {"chapterId": "chapter-2", "title": "第二章", "content": "正文二"},
            ]}
        raise AssertionError(method)

    automation.invoke = activity_invoke  # type: ignore[method-assign]
    with TestClient(build_app(runtime, None)) as client:
        response = client.post("/invoke", json={
            "requestId": "request-activities",
            "method": "agent.chat",
            "params": {
                "message": "感受这两章",
                "role": "reader",
                "conversationId": "conversation-activities",
                "chapterScope": {
                    "kind": "selected_chapters",
                    "chapterIds": ["chapter-1", "chapter-2"],
                    "processingMode": "detailed",
                },
            },
            "context": {"novelId": "novel-1"},
        }).json()
    assert response["ok"] is True
    activities = response["data"]["activities"]
    sequences = [event["sequence"] for event in activities]
    assert sequences == sorted(set(sequences))
    tool_events = [event for event in activities if event["type"].startswith("tool_")]
    call_ids = {event["callId"] for event in tool_events}
    assert len(call_ids) == 1
    for call_id in call_ids:
        types = [event["type"] for event in tool_events if event["callId"] == call_id]
        assert types == ["tool_started", "tool_completed"]


def test_review_comments_create_a_new_revision_run_and_artifact(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        comments = [{
            "commentId": "comment-1",
            "body": "加强人物在这一段的犹豫，并提前冲突。",
            "anchor": {"kind": "paragraph", "paragraphIndex": 1, "quote": "他停在门前。"},
        }]
        run = await runtime.revise_draft(
            {
                "sourceDraftSessionId": "draft_source_1",
                "sourceDraftVersion": 2,
                "sourceArtifactId": "artifact_source_1",
                "reviewRequestId": "review_request_1",
                "comments": comments,
                "threadId": "thread_review_1",
                "locale": "zh-CN",
            },
            {"origin": "desktop-ui"},
        )

        await runtime._run_tasks[run.runId]
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        assert completed.draftSessionId == "draft_revision_1"
        assert [method for method, _, _ in automation.calls] == ["draft.get", "chapter.revise_draft"]
        revision_params = automation.calls[-1][1]
        assert revision_params["sourceDraftSessionId"] == "draft_source_1"
        assert revision_params["sourceDraftVersion"] == 2
        assert revision_params["reviewRequestId"] == "review_request_1"
        assert revision_params["comments"] == comments
        assert len(completed.artifacts) == 1
        artifact = completed.artifacts[0]
        assert artifact.type == "chapter_draft"
        assert artifact.reference["draftSessionId"] == "draft_revision_1"
        assert artifact.metadata["revisionOfDraftSessionId"] == "draft_source_1"
        assert artifact.metadata["reviewRequestId"] == "review_request_1"
        assert artifact.metadata["sourceArtifactId"] == "artifact_source_1"

        with pytest.raises(ValueError, match="version conflict"):
            await runtime.revise_draft(
                {
                    "sourceDraftSessionId": "draft_source_2",
                    "sourceDraftVersion": 1,
                    "comments": comments,
                },
                {"origin": "desktop-ui"},
            )

    asyncio.run(scenario())


def test_creative_asset_review_comments_create_a_new_package_version(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        comments = [{
            "commentId": "comment-creative-1",
            "reviewVersionId": "creative_source_1",
            "body": "角色动机过于直接，保留身份设定但增加内在矛盾。",
            "anchor": {
                "kind": "asset_item",
                "targetId": "creative_source_1:characters:0",
                "fieldPath": "characters.0",
                "quote": "林岚；定位：调查记者",
            },
        }]
        run = await runtime.revise_draft(
            {
                "sourceDraftSessionId": "creative_source_1",
                "sourceDraftVersion": 2,
                "sourceArtifactId": "artifact_creative_source_1",
                "reviewRequestId": "review_creative_1",
                "comments": comments,
                "threadId": "thread_creative_1",
            },
            {"origin": "desktop-ui"},
        )

        await runtime._run_tasks[run.runId]
        completed = runtime.state.runs[run.runId]
        plan = runtime.state.plans[run.planId]
        assert completed.status == "completed"
        assert completed.draftSessionId == "creative_revision_1"
        assert plan.deliverable == "creative_assets_draft"
        assert plan.steps[0].tools == ["creative_assets.revise_draft"]
        assert [method for method, _, _ in automation.calls] == ["draft.get", "creative_assets.revise_draft"]
        assert automation.calls[-1][1]["comments"] == comments
        assert len(completed.artifacts) == 1
        artifact = completed.artifacts[0]
        assert artifact.type == "creative_assets_draft"
        assert artifact.reference["draftSessionId"] == "creative_revision_1"
        assert artifact.metadata["revisionOfDraftSessionId"] == "creative_source_1"
        assert artifact.metadata["reviewRequestId"] == "review_creative_1"
        assert artifact.metadata["sourceArtifactId"] == "artifact_creative_source_1"

    asyncio.run(scenario())


def test_agent_role_registry_is_complete_localized_and_tool_safe(tmp_path: Path) -> None:
    roles = list_agent_roles("zh-CN")
    english_roles = list_agent_roles("en-US")

    assert [role.id for role in roles] == ["team", "writer", "editor", "reader", "worldbuilding", "research_rag"]
    assert [role.label for role in english_roles] == ["Team", "Writer", "Editor", "Reader", "Worldbuilding", "Research"]
    assert {role.agent for role in roles} == {"supervisor", "writer", "editor", "reader", "worldbuilding", "research_rag"}

    allowed_tools = set(AVAILABLE_AGENT_TOOLS)
    preset_ids: list[str] = []
    for role in roles:
        assert role.tools
        assert set(role.tools).issubset(allowed_tools)
        assert role.skills
        assert role.presets
        preset_ids.extend(preset.id for preset in role.presets)
        assert all(preset.goal.strip() for preset in role.presets)
    assert len(preset_ids) == len(set(preset_ids))

    runtime, _ = create_runtime(tmp_path)
    runtime_roles = runtime.roles({"locale": "en-US"}, {})
    assert runtime_roles[0]["label"] == "Team"

    with TestClient(build_app(runtime, None)) as client:
        response = client.post(
            "/invoke",
            json={"method": "agent.roles", "params": {"locale": "zh-CN"}, "context": {}},
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["data"][4]["id"] == "worldbuilding"
    assert payload["data"][4]["label"] == "世界观"


def test_health_reports_active_fastmcp_tool_transport(tmp_path: Path) -> None:
    store = AgentStateStore(tmp_path)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(
        store,
        automation,
        AgentEventBus(store),
        tool_adapter=FastMcpAgentToolAdapter(automation),
    )
    with TestClient(build_app(runtime, None)) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["data"]["toolTransport"] == "fastmcp"
    assert "agent.retry_run" in response.json()["data"]["capabilities"]


def test_chat_request_exposes_progress_and_can_be_cancelled(tmp_path: Path) -> None:
    runtime, automation = create_runtime(tmp_path)
    started = asyncio.Event()

    async def slow_invoke(
        method: str,
        params: dict[str, Any],
        origin: str,
        request_id: str | None = None,
    ) -> Any:
        if method != "agent.generate_chat":
            raise AssertionError(method)
        started.set()
        await asyncio.sleep(30)
        return {"content": "不应完成", "toolCalls": []}

    automation.invoke = slow_invoke  # type: ignore[method-assign]
    with TestClient(build_app(runtime, None)) as client, ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(
            client.post,
            "/invoke",
            json={
                "requestId": "chat-cancel-1",
                "method": "agent.chat",
                "params": {
                    "message": "读取附件",
                    "conversationId": "runtime-conv",
                    "role": "team",
                    "approvalMode": "review_required",
                },
                "context": {"novelId": "novel_1"},
            },
        )
        progress = None
        for _ in range(50):
            progress = client.get("/progress/chat-cancel-1").json().get("data")
            if progress and any(event.get("type") == "model_started" for event in progress.get("events", [])):
                break
            time.sleep(0.02)
        assert progress and progress["events"][0]["phase"] == "thinking"
        cancelled = client.post("/cancel", json={"requestId": "chat-cancel-1"}).json()
        assert cancelled["data"]["cancelled"] is True
        response = future.result(timeout=5).json()
        assert response["code"] == "CANCELLED"
        assert any(request_id.startswith("call_") for request_id in automation.cancelled_request_ids)


def test_execute_plan_requires_explicit_approval(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        plan = await runtime.plan(
            {"goal": "续写下一段", "novelId": "novel_1", "chapterId": "chapter_3"},
            {},
        )

        with pytest.raises(ValueError, match="Explicit plan approval"):
            await runtime.execute_plan({"planId": plan.planId}, {})

    asyncio.run(scenario())


def test_plan_reuses_persisted_explicit_chapter_target_instead_of_reparsing_conversation_background(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        conversation_id = "conversation-resolved-target"
        runtime.state.intentDecisions[conversation_id] = {
            "interaction": "task",
            "route": "plan",
            "operations": [{
                "type": "chapter.rewrite",
                "target": {
                    "kind": "chapter",
                    "source": "explicit_id",
                    "id": "chapter-first",
                    "selector": "volume_chapter_ordinal",
                    "volumeId": "volume-first",
                    "title": "雨夜来电",
                },
                "suggestedToolchainId": "chapter.batch_rewrite",
                "suggestedToolchainVersion": "1.0.0",
                "requestedEffect": "draft_write",
                "confidence": 0.99,
            }],
            "deliverable": "chapter_draft",
            "requestedEffect": "draft_write",
            "needsClarification": False,
            "confidence": 0.99,
            "reasonCodes": ["TASK_REQUIRES_PLAN"],
            "responseContent": "改写第一卷第一章。",
        }
        runtime._save()

        plan = await runtime.plan(
            {
                "conversationId": conversation_id,
                "novelId": "novel-1",
                "goal": (
                    "修改第一卷第一章\n\n会话背景（仅用于理解当前任务）：\n"
                    "用户：之前请续写最后一章"
                ),
                # Simulate a renderer catalog that has not finished loading.
                "chapterCatalog": [],
            },
            {},
        )

        invocation = next(step.toolchain for step in plan.steps if step.toolchain is not None)
        assert invocation.id == "chapter.batch_rewrite"
        assert invocation.input["chapterId"] == "chapter-first"
        assert invocation.input["chapterIds"] == ["chapter-first"]
        assert invocation.input["_resolvedTarget"]["selector"] == "volume_chapter_ordinal"
        assert not any(method == "agent.generate_plan" for method, _, _ in automation.calls)
        assert not any(method == "volume.list" for method, _, _ in automation.calls)

    asyncio.run(scenario())


def test_execute_plan_requires_approved_steps_to_cover_declared_artifact(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        plan = await runtime.plan(
            {"goal": "续写下一段", "novelId": "novel_1", "chapterId": "chapter_3"},
            {},
        )
        read_step = next(step for step in plan.steps if "chapter.get" in step.tools)

        with pytest.raises(ValueError, match="do not produce the declared deliverable"):
            await runtime.execute_plan(
                {
                    "planId": plan.planId,
                    "approval": {"approved": True, "approvedStepIds": [read_step.stepId]},
                },
                {},
            )

    asyncio.run(scenario())


def test_run_fails_when_declared_artifact_is_not_created(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        plan = await runtime.plan({"goal": "续写下一段", "novelId": "novel_1"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        for _ in range(200):
            if runtime.state.runs[run.runId].status == "failed":
                break
            await asyncio.sleep(0.01)

        failed = runtime.state.runs[run.runId]
        assert failed.status == "failed"
        assert failed.artifacts == []
        assert any(
            event.type == "run_failed" and "chapter_draft" in str(event.payload.get("message"))
            for event in failed.events
        )
        assert not any(method == "agent.generate_report" for method, _, _ in automation.calls)

    asyncio.run(scenario())


def test_executor_graph_interrupt_persists_and_resumes_once(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def graph_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "LangGraph 审批恢复计划",
                    "deliverable": "report",
                    "steps": [{"agent": "editor", "title": "检索并报告", "tools": ["rag.ask"]}],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = graph_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "分析当前章节", "role": "editor"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )

        for _ in range(100):
            task = runtime._run_tasks.get(run.runId)  # noqa: SLF001 - verifies interrupt releases the worker task.
            if runtime.state.runs[run.runId].status == "waiting_user_input" and (task is None or task.done()):
                break
            await asyncio.sleep(0.01)

        waiting = runtime.state.runs[run.runId]
        assert waiting.status == "waiting_user_input"
        assert waiting.pendingUserInput is not None
        assert waiting.pendingApproval is not None
        assert (runtime._run_tasks.get(run.runId) is None or runtime._run_tasks[run.runId].done())  # noqa: SLF001
        checkpoint_db = sqlite3.connect(tmp_path / "agent_graph.db")
        try:
            assert checkpoint_db.execute("SELECT COUNT(*) FROM checkpoints").fetchone()[0] > 0
        finally:
            checkpoint_db.close()

        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": waiting.pendingApproval["checkpointId"],
                "selectedOptionIds": ["current_chapter"],
            }
        )
        for _ in range(200):
            if runtime.state.runs[run.runId].status in {"completed", "failed"}:
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        assert [method for method, _, _ in automation.calls].count("rag.ask") == 1
        approval_events = [event for event in runtime.state.runs[run.runId].events if event.type == "user_input_required"]
        assert len(approval_events) == 1

    asyncio.run(scenario())


def test_executor_graph_user_input_close_cancels_run_idempotently(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def graph_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "等待取消计划",
                    "deliverable": "report",
                    "steps": [{"agent": "editor", "title": "等待范围确认", "tools": ["rag.ask"]}],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = graph_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "分析章节"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {"novelId": "novel_1", "chapterId": "chapter_3"},
        )
        for _ in range(100):
            task = runtime._run_tasks.get(run.runId)  # noqa: SLF001
            if runtime.state.runs[run.runId].status == "waiting_user_input" and (task is None or task.done()):
                break
            await asyncio.sleep(0.01)

        pending_request = runtime.state.runs[run.runId].pendingUserInput
        assert pending_request is not None
        resolution = await runtime.dismiss_user_input({"requestId": pending_request.requestId}, {})
        assert resolution.status == "dismissed"
        assert resolution.nextAction == "run_cancelled"
        assert resolution.run is not None and resolution.run["status"] == "cancelled"
        cancelled = runtime.state.runs[run.runId]
        assert cancelled.pendingApproval is None
        assert cancelled.pendingUserInput is None
        assert cancelled.events[-1].type == "run_cancelled"
        repeated = await runtime.dismiss_user_input({"requestId": pending_request.requestId}, {})
        assert repeated.model_dump() == resolution.model_dump()

    asyncio.run(scenario())


def test_executor_graph_resumes_waiting_approval_after_runtime_restart(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def graph_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "跨进程恢复计划",
                    "deliverable": "report",
                    "steps": [{"agent": "editor", "title": "恢复后检索", "tools": ["rag.ask"]}],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = graph_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "检查恢复"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {"novelId": "novel_1", "chapterId": "chapter_3"},
        )
        for _ in range(100):
            task = runtime._run_tasks.get(run.runId)  # noqa: SLF001
            if runtime.state.runs[run.runId].status == "waiting_user_input" and (task is None or task.done()):
                break
            await asyncio.sleep(0.01)

        pending = runtime.state.runs[run.runId].pendingApproval
        assert pending is not None
        waiting_status = runtime.run_status({"runId": run.runId})
        assert waiting_status.status == "waiting_user_input"
        assert waiting_status.pendingApproval is not None
        assert waiting_status.pendingApproval["checkpointId"] == pending["checkpointId"]
        assert waiting_status.pendingUserInput is not None
        restarted = NovelAgentRuntime(runtime.store, automation, AgentEventBus(runtime.store))
        assert restarted.state.runs[run.runId].status == "waiting_user_input"
        assert restarted.state.runs[run.runId].pendingUserInput is not None
        assert restarted.state.runs[run.runId].pendingApproval is not None
        restarted_status = restarted.run_status({"runId": run.runId})
        assert restarted_status.pendingApproval is not None
        assert restarted_status.pendingApproval["checkpointId"] == pending["checkpointId"]
        assert restarted_status.pendingUserInput is not None

        await restarted.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": pending["checkpointId"],
                "selectedOptionIds": ["current_chapter"],
            }
        )
        for _ in range(200):
            if restarted.state.runs[run.runId].status in {"completed", "failed"}:
                break
            await asyncio.sleep(0.01)

        assert restarted.state.runs[run.runId].status == "completed"
        assert [method for method, _, _ in automation.calls].count("rag.ask") == 1

    asyncio.run(scenario())


def test_reader_plan_maps_current_volume_to_chapter_list(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def reader_plan_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "读者视角检查计划",
                    "steps": [
                        {"agent": "reader", "title": "对照当前卷章节节奏", "tools": ["chapter.list"]},
                    ],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = reader_plan_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "从读者视角检查追更欲望", "role": "reader"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "approval": {"approved": True, "approvedStepIds": [plan.steps[0].stepId]},
            },
            {
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
                "locale": "zh-CN",
            },
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status in {"completed", "failed"}:
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        chapter_list_call = next(params for method, params, _ in automation.calls if method == "chapter.list")
        assert chapter_list_call == {"volumeId": "volume_1"}

    asyncio.run(scenario())


def test_chat_uses_model_interface_and_returns_plan_signal(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        response = await runtime.chat(
            {
                "message": "帮我分析第三章的冲突",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_1",
            },
            {"locale": "zh-CN"},
        )

        assert response.assistantMessage.content == "我会分析这一章的冲突目标。"
        assert response.suggestedActions == [{"label": "生成计划草稿", "method": "agent.plan"}]
        assert response.awaitingUserInput is False
        method, params, _ = automation.calls[0]
        assert method == "agent.generate_chat"
        assert params["role"] == "editor"
        assert "currentContent" not in params

    asyncio.run(scenario())


def test_chat_intent_decision_flows_into_operation_routed_plan(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        response = await runtime.chat(
            {
                "message": "检查当前章节的一致性和设定冲突",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_intent_plan",
                "chapterId": "chapter_3",
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )

        assert response.intentDecision is not None
        assert response.intentDecision.route == "plan"
        assert response.intentDecision.operations[0].type == "chapter.consistency_review"
        assert response.intentDecision.operations[0].suggestedToolchainId == "chapter.consistency_review"
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat"]

        plan = await runtime.plan(
            {
                "goal": "检查当前章节的一致性和设定冲突",
                "role": "editor",
                "chapterId": "chapter_3",
                "intentDecision": response.intentDecision.model_dump(),
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )
        assert not any(method == "agent.generate_plan" for method, _, _ in automation.calls)
        assert plan.deliverable == "report"
        assert plan.requiresApproval is False
        assert len(plan.steps) == 1
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "chapter.consistency_review"
        run = await runtime.execute_plan(
            {"planId": plan.planId, "chapterId": "chapter_3", "novelId": "novel_1"},
            {"novelId": "novel_1", "chapterId": "chapter_3"},
        )
        approved = next(event for event in run.events if event.type == "plan_approved")
        assert approved.payload["approvalSource"] == "policy"
        await runtime.cancel({"runId": run.runId})

    asyncio.run(scenario())


def test_read_only_plans_run_without_approval_regardless_of_scope_or_planner(tmp_path: Path) -> None:
    async def build_for_scope(chapter_ids: list[str]) -> tuple[NovelAgentRuntime, FakeAutomationClient, Any]:
        runtime, automation = create_runtime(tmp_path / f"scope-{len(chapter_ids)}")

        async def semantic_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_plan":
                raise AssertionError("Stable Toolchain must skip the model Planner")
            if method != "agent.generate_chat":
                raise AssertionError(method)
            assert params["toolObservations"] == []
            assert "currentContent" not in params["selectionContext"]
            assert params["selectionContext"]["chapterScope"]["chapterIds"] == chapter_ids
            return {
                "content": "我会按阅读顺序感受这些章节。",
                "shouldPlan": True,
                "requestedOperations": ["reader.journey_review"],
                "deliverable": "expert_report",
                "suggestedRole": "reader",
                "toolCalls": [{"name": "chapter.scope_context.build", "args": {"chapterIds": ["forged"]}}],
            }

        automation.invoke = semantic_invoke  # type: ignore[method-assign]
        scope = {
            "kind": "selected_chapters",
            "chapterIds": chapter_ids,
            "processingMode": "detailed",
        }
        response = await runtime.chat(
            {
                "message": "感受下这几章" if len(chapter_ids) > 2 else "感受下这两章",
                "role": "reader",
                "conversationId": f"reader-scope-{len(chapter_ids)}",
                "novelId": "novel-1",
                "chapterId": chapter_ids[0],
                "currentContentText": "编辑器未保存正文",
                "chapterScope": scope,
            },
            {},
        )
        assert response.intentDecision is not None
        plan = await runtime.plan(
            {
                "goal": response.assistantMessage.content,
                "role": "reader",
                "novelId": "novel-1",
                "chapterId": chapter_ids[0],
                "chapterScope": scope,
                "intentDecision": response.intentDecision.model_dump(),
            },
            {},
        )
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat"]
        assert plan.steps[0].toolchain and plan.steps[0].toolchain.id == "reader.journey_review"
        return runtime, automation, plan

    async def scenario() -> None:
        _small_runtime, _small_automation, small_plan = await build_for_scope(["chapter-1", "chapter-2"])
        assert small_plan.requiresApproval is False

        large_runtime, _large_automation, large_plan = await build_for_scope([
            "chapter-1", "chapter-2", "chapter-3", "chapter-4",
        ])
        assert large_plan.requiresApproval is False

        dynamic_runtime, dynamic_automation = create_runtime(tmp_path / "dynamic-planner")

        async def dynamic_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            dynamic_automation.calls.append((method, params, origin))
            assert method == "agent.generate_plan"
            return {
                "title": "动态读者计划",
                "deliverable": "expert_report",
                "steps": [{
                    "agent": "reader",
                    "title": "读者旅程",
                    "tools": [],
                    "toolchain": {"id": "reader.journey_review", "version": "1.0.0", "input": {}},
                }],
            }

        dynamic_automation.invoke = dynamic_invoke  # type: ignore[method-assign]
        dynamic_plan = await dynamic_runtime.plan(
            {
                "goal": "模型动态组合一个读者计划",
                "role": "reader",
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "chapterScope": {
                    "kind": "selected_chapters",
                    "chapterIds": ["chapter-1", "chapter-2"],
                    "processingMode": "detailed",
                },
            },
            {},
        )
        assert dynamic_plan.requiresApproval is False

    asyncio.run(scenario())


def test_automatic_mode_runs_reversible_draft_plans_without_plan_approval(tmp_path: Path) -> None:
    async def scenario() -> None:
        automatic_runtime, _ = create_runtime(tmp_path / "automatic")
        automatic = await automatic_runtime.plan(
            {
                "goal": "续写当前章节",
                "role": "writer",
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "approvalMode": "full_control",
            },
            {},
        )
        assert automatic.deliverable == "chapter_draft"
        assert automatic.requestedEffect == "draft_write"
        assert automatic.requiresApproval is False

        review_runtime, _ = create_runtime(tmp_path / "review")
        reviewed = await review_runtime.plan(
            {
                "goal": "续写当前章节",
                "role": "writer",
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "approvalMode": "review_required",
            },
            {},
        )
        assert reviewed.requiresApproval is True

    asyncio.run(scenario())


def test_automatic_mode_does_not_pause_for_scope_evidence_or_direction(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def automatic_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "自动续写计划",
                    "deliverable": "chapter_draft",
                    "steps": [{
                        "agent": "writer",
                        "title": "分析并续写",
                        "tools": ["rag.ask", "chapter.generate_draft"],
                    }],
                }
            if method == "rag.ask":
                automation.calls.append((method, params, origin))
                return {"answer": "证据有限，按当前章继续。", "confidence": "low", "warnings": ["证据有限"], "evidence": []}
            if method == "agent.detect_creative_direction":
                raise AssertionError("automatic mode must not request a creative direction decision")
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = automatic_invoke  # type: ignore[method-assign]
        install_durable_draft_protocol(automation)
        plan = await runtime.plan(
            {
                "goal": "根据当前章直接续写",
                "role": "writer",
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "approvalMode": "full_control",
            },
            {},
        )
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "approvalMode": "full_control",
            },
            {},
        )
        await runtime._run_tasks[run.runId]
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        assert completed.pendingApproval is None
        assert completed.pendingUserInput is None
        assert not any(event.type in {"approval_required", "user_input_required"} for event in completed.events)

    asyncio.run(scenario())


@pytest.mark.parametrize(("role", "operation", "expected_approval"), [
    ("writer", "writer.range_revision_plan", False),
    ("editor", "editor.range_review", False),
    ("reader", "reader.journey_review", False),
    ("worldbuilding", "worldbuilding.range_consistency", False),
    ("research_rag", "research.range_fact_check", False),
    ("team", "novel.scope_audit", False),
])
def test_role_scope_plans_share_semantic_first_policy(
    tmp_path: Path,
    role: str,
    operation: str,
    expected_approval: bool,
) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def semantic_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            assert params["toolObservations"] == []
            assert "currentContent" not in params["selectionContext"]
            return {
                "content": "我会处理所选章节。",
                "shouldPlan": True,
                "requestedOperations": [operation],
                "deliverable": "expert_report",
                "suggestedRole": role,
                "toolCalls": [],
            }

        automation.invoke = semantic_invoke  # type: ignore[method-assign]
        scope = {
            "kind": "selected_chapters",
            "chapterIds": ["chapter-1", "chapter-2"],
            "processingMode": "detailed",
        }
        response = await runtime.chat(
            {
                "message": "处理所选章节",
                "role": role,
                "conversationId": f"role-{role}",
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "chapterScope": scope,
            },
            {},
        )
        assert response.intentDecision is not None
        plan = await runtime.plan(
            {
                "goal": "处理所选章节",
                "role": role,
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "chapterScope": scope,
                "intentDecision": response.intentDecision.model_dump(),
            },
            {},
        )
        assert plan.requiresApproval is expected_approval
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat"]

    asyncio.run(scenario())


def test_stable_read_only_composite_skips_planner_and_plan_approval(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def semantic_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            return {
                "content": "我会先做作者评估，再做编辑审核。",
                "shouldPlan": True,
                "requestedOperations": ["writer.range_revision_plan", "editor.range_review"],
                "deliverable": "expert_report",
                "suggestedRole": "team",
                "toolCalls": [],
            }

        automation.invoke = semantic_invoke  # type: ignore[method-assign]
        scope = {
            "kind": "selected_chapters",
            "chapterIds": ["chapter-1", "chapter-2"],
            "processingMode": "detailed",
        }
        response = await runtime.chat(
            {
                "message": "先做作者评估，再做编辑审核",
                "role": "team",
                "conversationId": "stable-composite",
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "chapterScope": scope,
            },
            {},
        )
        assert response.intentDecision is not None
        plan = await runtime.plan(
            {
                "goal": "先做作者评估，再做编辑审核",
                "role": "team",
                "novelId": "novel-1",
                "chapterId": "chapter-1",
                "chapterScope": scope,
                "intentDecision": response.intentDecision.model_dump(),
            },
            {},
        )
        assert [step.toolchain.id for step in plan.steps if step.toolchain] == [
            "writer.range_revision_plan",
            "editor.range_review",
        ]
        assert plan.requiresApproval is False
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_follow_up_inherits_previous_intent_without_model_reclassification(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        first = await runtime.chat(
            {
                "message": "新增一段世界观设定",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_reference",
            },
            {"novelId": "novel_1", "locale": "zh-CN"},
        )
        assert first.intentDecision is not None
        assert first.intentDecision.operations[0].type == "creative_asset.draft"

        second = await runtime.chat(
            {
                "message": "按刚才那个方案继续",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_reference",
            },
            {"novelId": "novel_1", "locale": "zh-CN"},
        )
        assert second.intentDecision is not None
        assert [operation.type for operation in second.intentDecision.operations] == ["creative_asset.draft"]
        assert second.intentDecision.deliverable == "creative_assets_draft"
        assert "PREVIOUS_INTENT_INHERITED" in second.intentDecision.reasonCodes

    asyncio.run(scenario())


def test_chat_langgraph_reads_project_context_on_demand_before_answering(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        model_calls = 0

        async def exploration_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal model_calls
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                model_calls += 1
                if not params["toolObservations"]:
                    assert "plotline.list" in params["availableReadTools"]
                    return {
                        "content": "我先查看当前大纲。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{"name": "plotline.list", "args": {}}],
                    }
                assert params["toolObservations"][0]["toolName"] == "plotline.list"
                return {
                    "content": "当前主线在觉醒后缺少代价节点，建议先补足代价。",
                    "shouldPlan": False,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "plotline.list":
                assert params == {"novelId": "novel_1"}
                return {"plotLines": [{"title": "觉醒主线", "status": "active"}]}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = exploration_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "当前大纲的主线有什么问题？直接回答，不要生成计划。",
                "role": "writer",
                "approvalMode": "review_required",
                "conversationId": "conv_exploration",
            },
            {"novelId": "novel_1", "locale": "zh-CN"},
        )

        assert model_calls == 2
        assert response.assistantMessage.content.startswith("当前主线")
        assert [
            {"toolName": item["toolName"], "status": item["status"]}
            for item in response.contextReads
        ] == [{"toolName": "plotline.list", "status": "completed"}]
        assert response.contextReads[0]["callId"].startswith("call_")
        assert response.contextReads[0]["sourceTitle"] == "plotline.list"
        assert response.contextReads[0]["elapsedMs"] >= 0
        assert response.suggestedActions == []

    asyncio.run(scenario())


def test_chat_langgraph_can_execute_project_reads_through_fastmcp(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        automation = FakeAutomationClient()
        model_calls = 0

        async def exploration_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal model_calls
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                model_calls += 1
                if not params["toolObservations"]:
                    return {
                        "content": "我先读取当前章节。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{"name": "chapter.get", "args": {}}],
                    }
                observation = params["toolObservations"][0]
                assert observation["result"]["title"] == "第三章"
                return {
                    "content": "当前章节已读取，可以继续审校。",
                    "shouldPlan": False,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "chapter.get":
                assert request_id is not None and request_id.startswith("call_")
                assert params == {"chapterId": "chapter_3"}
                return {"id": "chapter_3", "title": "第三章"}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = exploration_invoke  # type: ignore[method-assign]
        adapter = FastMcpAgentToolAdapter(automation)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store), tool_adapter=adapter)

        response = await runtime.chat(
            {
                "message": "审校当前章节。",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_fastmcp_exploration",
            },
            {"novelId": "novel_1", "chapterId": "chapter_3", "locale": "zh-CN"},
        )

        assert runtime.tool_transport == "fastmcp"
        assert model_calls == 2
        assert [
            {"toolName": item["toolName"], "status": item["status"]}
            for item in response.contextReads
        ] == [{"toolName": "chapter.get", "status": "completed"}]
        assert response.contextReads[0]["callId"].startswith("call_")
        assert response.contextReads[0]["sourceTitle"] == "第三章"
        assert response.contextReads[0]["elapsedMs"] >= 0
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat", "chapter.get", "agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_attachment_reads_are_scoped_to_active_conversation(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        model_calls = 0

        async def attachment_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal model_calls
            if method == "agent.generate_chat":
                model_calls += 1
                scope = params["selectionContext"]["attachmentScope"]
                assert scope == {"novelId": "novel_1", "conversationId": "desktop_conv_1"}
                if not params["toolObservations"]:
                    return {
                        "content": "我先搜索附件。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{
                            "name": "attachment.search",
                            "args": {
                                "novelId": "novel_other",
                                "conversationId": "conv_other",
                                "attachmentId": "attachment_1",
                                "query": "关键线索",
                                "limit": 99,
                            },
                        }],
                    }
                if len(params["toolObservations"]) == 1:
                    return {
                        "content": "我再读取命中位置。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{
                            "name": "attachment.get",
                            "args": {"attachmentId": "attachment_1", "offset": 0, "limit": 4000},
                        }],
                    }
                return {
                    "content": "附件已读取。",
                    "shouldPlan": False,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "attachment.search":
                assert params == {
                    "novelId": "novel_1",
                    "conversationId": "desktop_conv_1",
                    "attachmentId": "attachment_1",
                    "query": "关键线索",
                    "limit": 20,
                }
                return {"matches": [{"attachmentId": "attachment_1", "startOffset": 0, "endOffset": 4}]}
            if method == "attachment.get":
                assert params == {
                    "novelId": "novel_1",
                    "conversationId": "desktop_conv_1",
                    "attachmentId": "attachment_1",
                    "offset": 0,
                    "limit": 4000,
                }
                return {"text": "attachment content", "nextOffset": None}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = attachment_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "读取附件并总结。",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "runtime_conv_1",
                "agentConversationId": "desktop_conv_1",
                "attachments": [{
                    "attachmentId": "attachment_1",
                    "fileName": "outline.md",
                    "characterCount": 18,
                }],
            },
            {"novelId": "novel_1", "locale": "zh-CN"},
        )

        assert model_calls == 3
        assert [
            {"toolName": item["toolName"], "status": item["status"]}
            for item in response.contextReads
        ] == [
            {"toolName": "attachment.search", "status": "completed"},
            {"toolName": "attachment.get", "status": "completed"},
        ]
        assert all(item["callId"].startswith("call_") for item in response.contextReads)
        assert all(item["elapsedMs"] >= 0 for item in response.contextReads)

    asyncio.run(scenario())


def test_attachment_read_and_get_offset_aliases_are_normalized(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            assert origin == "desktop-ui"
            assert request_id == "chat-request-1"
            if method == "attachment.get":
                assert params == {
                    "novelId": "novel_1",
                    "conversationId": "desktop_conv_1",
                    "attachmentId": "attachment_1",
                    "offset": 12,
                    "limit": 30,
                }
                return {"text": "window"}
            if method == "attachment.read":
                assert params["selector"] == {"kind": "section", "title": "第二章"}
                return {"status": "resolved", "text": "第二章正文"}
            raise AssertionError(method)

        automation.invoke = invoke  # type: ignore[method-assign]
        context = {
            "novelId": "novel_1",
            "agentConversationId": "desktop_conv_1",
            "volumeId": "",
            "chapterId": "",
        }
        result = await runtime._invoke_exploration_tool(  # noqa: SLF001
            "attachment.get",
            {"attachmentId": "attachment_1", "startOffset": 12, "endOffset": 42},
            "读取",
            context,
            "zh-CN",
            "chat-request-1",
        )
        assert result == {"text": "window"}
        result = await runtime._invoke_exploration_tool(  # noqa: SLF001
            "attachment.read",
            {"attachmentId": "attachment_1", "selector": {"kind": "section", "title": "第二章"}},
            "读取",
            context,
            "zh-CN",
            "chat-request-1",
        )
        assert result["text"] == "第二章正文"
        with pytest.raises(ValueError, match="startOffset"):
            await runtime._invoke_exploration_tool(  # noqa: SLF001
                "attachment.get",
                {"attachmentId": "attachment_1", "startOffset": 50, "endOffset": 20},
                "读取",
                context,
                "zh-CN",
            )

    asyncio.run(scenario())


def test_chat_selected_chapter_context_redirects_redundant_discovery(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        model_calls = 0

        async def selected_chapter_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            nonlocal model_calls
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                model_calls += 1
                selection = params["selectionContext"]
                assert selection["novelTitle"] == "七夜"
                assert selection["chapterId"] == "chapter_3"
                assert selection["chapterTitle"] == "残响觉醒"
                assert "currentContent" not in selection
                if not params["toolObservations"]:
                    return {
                        "content": "我先确认你要校验哪一章。",
                        "shouldPlan": False,
                        "needsClarification": True,
                        "toolCalls": [{"name": "volume.list", "args": {}}],
                    }
                assert params["toolObservations"][0]["toolName"] == "chapter.get"
                assert params["toolObservations"][0]["result"]["content"] == "当前编辑器正文"
                assert params["toolObservations"][0]["result"]["contentSource"] == "editor_snapshot"
                return {
                    "content": "当前选中章节的校验结论如下。",
                    "shouldPlan": False,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "chapter.get":
                assert params == {"chapterId": "chapter_3"}
                return {"id": "chapter_3", "title": "残响觉醒"}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = selected_chapter_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "帮我校验这篇文章，只讨论不要生成计划",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_selected_chapter",
                "novelId": "novel_1",
                "novelTitle": "七夜",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
                "chapterTitle": "残响觉醒",
                "currentContentText": "当前编辑器正文",
            },
            {"locale": "zh-CN"},
        )

        assert model_calls == 2
        assert response.awaitingUserInput is False
        assert response.intentDecision is not None
        assert response.intentDecision.route == "respond"
        assert [
            {"toolName": item["toolName"], "status": item["status"]}
            for item in response.contextReads
        ] == [{"toolName": "chapter.get", "status": "completed"}]
        assert response.contextReads[0]["callId"].startswith("call_")
        assert response.contextReads[0]["sourceTitle"] == "残响觉醒"
        assert response.contextReads[0]["elapsedMs"] >= 0
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat", "chapter.get", "agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_explicit_cross_chapter_scope_keeps_discovery_tool(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def cross_chapter_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                if not params["toolObservations"]:
                    return {
                        "content": "我先读取当前卷的章节结构。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{"name": "volume.list", "args": {}}],
                    }
                assert params["toolObservations"][0]["toolName"] == "volume.list"
                return {
                    "content": "我会校验当前章节和相邻章节。",
                    "shouldPlan": True,
                    "needsClarification": False,
                    "toolCalls": [],
                }
            if method == "volume.list":
                return [{"id": "volume_1", "title": "第一卷"}]
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = cross_chapter_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "帮我校验这篇文章和相邻章节",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_cross_chapter",
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
            },
            {"locale": "zh-CN"},
        )

        assert [
            {"toolName": item["toolName"], "status": item["status"]}
            for item in response.contextReads
        ] == [{"toolName": "volume.list", "status": "completed"}]
        assert response.contextReads[0]["callId"].startswith("call_")
        assert response.contextReads[0]["sourceTitle"] == "volume.list"
        assert response.contextReads[0]["elapsedMs"] >= 0
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat", "volume.list", "agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_context_scope_is_seed_and_model_can_read_prior_chapters(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def expanding_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                observations = params["toolObservations"]
                assert params["selectionContext"]["chapterScope"]["chapterIds"] == ["chapter_3"]
                assert params["selectionContext"]["readPolicy"]["allowExpansion"] is True
                assert "chapter.list" in params["availableReadTools"]
                assert "chapter.get" in params["availableReadTools"]
                if not observations:
                    # Runtime first redirects broad discovery to the resolved
                    # operation target so the target cannot drift.
                    return {
                        "content": "先读取第三章。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{"name": "volume.list", "args": {}}],
                    }
                if len(observations) == 1:
                    assert observations[0]["toolName"] == "chapter.get"
                    assert observations[0]["args"] == {"chapterId": "chapter_3"}
                    return {
                        "content": "申请查看目录以定位前文。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [{"name": "chapter.list", "args": {"volumeId": "volume_1"}}],
                    }
                if len(observations) == 2:
                    assert observations[1]["toolName"] == "chapter.list"
                    return {
                        "content": "补读第一、二章。",
                        "shouldPlan": False,
                        "needsClarification": False,
                        "toolCalls": [
                            {"name": "chapter.get", "args": {"chapterId": "chapter_1"}},
                            {"name": "chapter.get", "args": {"chapterId": "chapter_2"}},
                        ],
                    }
                assert [item["args"]["chapterId"] for item in observations[-2:]] == ["chapter_1", "chapter_2"]
                return {
                    "content": "上下文已补齐，可以续写第三章。",
                    "shouldPlan": True,
                    "needsClarification": False,
                    "requestedOperations": ["chapter.continuation"],
                    "deliverable": "chapter_draft",
                    "toolCalls": [],
                }
            if method == "chapter.get":
                chapter_id = params["chapterId"]
                return {"id": chapter_id, "title": chapter_id, "content": f"{chapter_id} 正文"}
            if method == "chapter.list":
                return [{"id": f"chapter_{index}", "title": f"第{index}章"} for index in range(1, 4)]
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = expanding_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "续写第三章",
                "role": "writer",
                "approvalMode": "review_required",
                "conversationId": "conv_expand_context_scope",
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
                "currentContentText": "第三章编辑器正文",
                "chapterCatalog": [
                    {"chapterId": f"chapter_{index}", "title": f"第{index}章", "chapterOrder": index,
                     "volumeId": "volume_1", "volumeTitle": "第一卷", "volumeOrder": 1}
                    for index in range(1, 4)
                ],
                "chapterScope": {
                    "scopeId": "scope_seed_only",
                    "kind": "selected_chapters",
                    "chapterIds": ["chapter_3"],
                    "processingMode": "detailed",
                },
            },
            {"locale": "zh-CN"},
        )

        assert response.intentDecision is not None
        assert response.intentDecision.route == "plan"
        assert response.intentDecision.operations[0].target.id == "chapter_3"
        assert [method for method, _, _ in automation.calls] == [
            "agent.generate_chat",
            "chapter.get",
            "agent.generate_chat",
            "chapter.list",
            "agent.generate_chat",
            "chapter.get",
            "chapter.get",
            "agent.generate_chat",
        ]

    asyncio.run(scenario())


def test_chat_explicit_read_policy_can_lock_selected_context_scope(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def restricted_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            assert "chapter.scope_context.build" in params["availableReadTools"]
            assert "chapter.list" not in params["availableReadTools"]
            assert "chapter.get" not in params["availableReadTools"]
            assert params["selectionContext"]["readPolicy"]["restrictToContextScope"] is True
            return {
                "content": "会严格只使用所选章节。",
                "shouldPlan": False,
                "needsClarification": False,
                "toolCalls": [],
            }

        automation.invoke = restricted_invoke  # type: ignore[method-assign]
        await runtime.chat(
            {
                "message": "只看第三章，分析节奏",
                "role": "editor",
                "approvalMode": "review_required",
                "conversationId": "conv_restricted_context_scope",
                "novelId": "novel_1",
                "volumeId": "volume_1",
                "chapterId": "chapter_3",
                "chapterScope": {
                    "scopeId": "scope_restricted",
                    "kind": "selected_chapters",
                    "chapterIds": ["chapter_3"],
                    "processingMode": "detailed",
                },
            },
            {"locale": "zh-CN"},
        )

    asyncio.run(scenario())


def test_chat_langgraph_rejects_non_read_only_tool_calls(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def unsafe_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            return {
                "content": "我会先形成计划，未经批准不写回。",
                "shouldPlan": True,
                "needsClarification": False,
                "toolCalls": [{"name": "outline.write", "args": {"title": "越权写入"}}],
            }

        automation.invoke = unsafe_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "修改大纲。",
                "approvalMode": "review_required",
                "conversationId": "conv_unsafe_tool",
            },
            {"novelId": "novel_1"},
        )

        assert response.contextReads == []
        assert [method for method, _, _ in automation.calls] == ["agent.generate_chat"]

    asyncio.run(scenario())


def test_chat_waits_for_clarification_before_suggesting_plan(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        async def clarification_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                return {
                    "content": "需要你确认新增方向。",
                    "shouldPlan": True,
                    "needsClarification": True,
                    "inputRequest": {
                        "title": "确认新增方向",
                        "reason": "不同方向会形成不同的计划步骤。",
                        "questions": [{
                            "questionId": "addition_kind",
                            "header": "新增类型",
                            "prompt": "你想新增哪一类内容？",
                            "options": [
                                {"optionId": "world", "label": "世界观设定", "description": "补充规则、历史或地理设定。"},
                                {"optionId": "plot", "label": "剧情线", "description": "补充主线或支线推进。"},
                                {"optionId": "character", "label": "角色支线", "description": "补充角色专属目标与冲突。"},
                            ],
                            "recommendedOptionId": "world",
                            "recommendationReason": "当前角色是世界观设计，优先补充世界设定。",
                        }],
                    },
                }
            return await FakeAutomationClient().invoke(method, params, origin, request_id=request_id)

        automation.invoke = clarification_invoke  # type: ignore[method-assign]
        first = await runtime.chat(
            {
                "message": "大纲新增一部分。",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_clarification",
                "messageId": "message-clarification",
            },
            {"locale": "zh-CN"},
        )
        assert first.awaitingUserInput is True
        assert first.suggestedActions == []
        assert first.pendingUserInput is not None
        assert first.pendingUserInput.sourceMessageId == "message-clarification"
        assert len(first.pendingUserInput.questions) == 1

        resolution = await runtime.submit_user_input(
            {
                "requestId": first.pendingUserInput.requestId,
                "conversationId": "conv_clarification",
                "answers": [{
                    "questionId": "addition_kind",
                    "answerKind": "option",
                    "selectedOptionId": "world",
                }],
            },
            {"locale": "zh-CN"},
        )
        assert resolution.nextAction == "plan_created"
        assert resolution.plan is not None
        assert resolution.plan.userDecisions is not None
        assert resolution.plan.userDecisions["answers"][0]["selectedOptionId"] == "world"
        repeated = await runtime.submit_user_input(
            {"requestId": first.pendingUserInput.requestId, "answers": []},
            {"locale": "zh-CN"},
        )
        assert repeated.model_dump() == resolution.model_dump()

    asyncio.run(scenario())


@pytest.mark.parametrize("question_count", [1, 2, 3])
def test_chat_accepts_one_to_three_blocking_questions(tmp_path: Path, question_count: int) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def questions_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            questions = []
            for index in range(question_count):
                questions.append({
                    "questionId": f"decision_{index + 1}",
                    "header": f"方向 {index + 1}",
                    "prompt": f"请选择第 {index + 1} 个关键方向。",
                    "options": [
                        {"optionId": f"recommended_{index + 1}", "label": "推荐方向", "description": "最贴合当前目标。"},
                        {"optionId": f"alternative_{index + 1}", "label": "备选方向", "description": "更偏向另一种取舍。"},
                    ],
                    "recommendedOptionId": f"recommended_{index + 1}",
                    "recommendationReason": "基于当前任务，第一项更稳妥。",
                })
            return {
                "content": "需要确认关键方向。",
                "shouldPlan": True,
                "needsClarification": True,
                "inputRequest": {"title": "关键方向确认", "reason": "这些选择会改变计划。", "questions": questions},
            }

        automation.invoke = questions_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "先确认方向再生成计划。",
                "role": "writer",
                "conversationId": f"conv_questions_{question_count}",
            },
            {},
        )

        assert response.pendingUserInput is not None
        assert len(response.pendingUserInput.questions) == question_count
        assert all(
            question.recommendedOptionId == question.options[0].optionId
            for question in response.pendingUserInput.questions
        )

    asyncio.run(scenario())


def test_preplan_multi_question_reads_all_selected_chapters_and_submits_atomically(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def evidence_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "chapter.scope_context.build":
                assert params["chapterIds"] == ["chapter_1", "chapter_2"]
                assert params["currentContent"] == "编辑器未保存正文"
                return {
                    "chapters": [
                        {"chapterId": "chapter_1", "title": "章节 chapter_1", "content": params["currentContent"], "contentHash": "hash-1"},
                        {"chapterId": "chapter_2", "title": "章节 chapter_2", "content": "正文", "contentHash": "hash-2"},
                    ],
                    "sourceSnapshot": [
                        {"chapterId": "chapter_1", "version": 1, "contentHash": "hash-1", "updatedAt": "2026-07-28T00:00:00Z", "source": "editor_buffer"},
                        {"chapterId": "chapter_2", "version": 1, "contentHash": "hash-2", "updatedAt": "2026-07-28T00:00:01Z", "source": "database"},
                    ],
                }
            if method == "agent.generate_chat":
                if not params["toolObservations"]:
                    assert "currentContent" not in params["selectionContext"]
                    return {
                        "content": "我先读取这两章，再确认会影响改写的方向。",
                        "shouldPlan": False,
                        "toolCalls": [{"name": "chapter.scope_context.build", "args": {"chapterIds": ["forged"]}}],
                    }
                assert [item["toolName"] for item in params["toolObservations"]] == ["chapter.scope_context.build"]
                assert params["toolObservations"][0]["result"]["chapters"][0]["content"] == "编辑器未保存正文"
                return {
                    "content": "正文读取完成，需要确认两个方向。",
                    "shouldPlan": True,
                    "needsClarification": True,
                    "requestedOperations": ["chapter.batch_rewrite"],
                    "deliverable": "chapter_draft_batch",
                    "inputRequest": {
                        "title": "改写方向确认",
                        "reason": "两个决定都会影响改写计划。",
                        "questions": [
                            {
                                "questionId": "betrayal_kind",
                                "header": "背叛方式",
                                "prompt": "主角的背叛更偏向哪一种？",
                                "options": [
                                    {"optionId": "active", "label": "主动背叛", "description": "主角主动选择利益交换。"},
                                    {"optionId": "forced", "label": "被迫背叛", "description": "主角受威胁而被迫行动。"},
                                ],
                                "recommendedOptionId": "active",
                                "recommendationReason": "主动选择能强化人物能动性。",
                            },
                            {
                                "questionId": "reveal_timing",
                                "header": "揭露时机",
                                "prompt": "背叛事实何时揭露？",
                                "options": [
                                    {"optionId": "chapter_end", "label": "章末揭露", "description": "形成明确追更钩子。"},
                                    {"optionId": "next_chapter", "label": "下章揭露", "description": "本章只埋下可疑线索。"},
                                ],
                                "recommendedOptionId": "chapter_end",
                                "recommendationReason": "章末揭露能直接兑现本次增强张力的目标。",
                            },
                        ],
                    },
                }
            if method == "agent.summarize_user_input":
                return {"summary": "主角主动背叛；揭露时机按用户自定义安排。"}
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = evidence_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "批量改写章节，让这两章更有张力；主角背叛方式还没决定。",
                "role": "writer",
                "conversationId": "conv_multi_evidence",
                "novelId": "novel_1",
                "chapterId": "chapter_1",
                "currentContentText": "编辑器未保存正文",
                "chapterScope": {
                    "kind": "selected_chapters",
                    "chapterIds": ["chapter_1", "chapter_2"],
                    "processingMode": "detailed",
                },
            },
            {},
        )

        request = response.pendingUserInput
        assert request is not None
        assert [item.sourceId for item in request.evidence] == ["chapter_1", "chapter_2"]
        assert [method for method, _, _ in automation.calls[:3]] == [
            "agent.generate_chat",
            "chapter.scope_context.build",
            "agent.generate_chat",
        ]

        with pytest.raises(ValueError, match="Unknown option"):
            await runtime.submit_user_input(
                {
                    "requestId": request.requestId,
                    "answers": [
                        {"questionId": "betrayal_kind", "answerKind": "option", "selectedOptionId": "missing"},
                        {"questionId": "reveal_timing", "answerKind": "option", "selectedOptionId": "chapter_end"},
                    ],
                },
                {},
            )
        assert request.requestId in runtime.state.pendingUserInputs
        assert not any(method == "agent.generate_plan" for method, _, _ in automation.calls)

        valid_payload = {
            "requestId": request.requestId,
            "answers": [
                {"questionId": "betrayal_kind", "answerKind": "option", "selectedOptionId": "active"},
                {"questionId": "reveal_timing", "answerKind": "custom", "customText": "先让配角发现，章末再让主角承认。"},
            ],
        }
        resolution, concurrent_resolution = await asyncio.gather(
            runtime.submit_user_input(valid_payload, {}),
            runtime.submit_user_input(valid_payload, {}),
        )
        assert resolution.plan is not None
        assert concurrent_resolution.plan is not None
        assert concurrent_resolution.plan.planId == resolution.plan.planId
        assert resolution.understandingSummary == "主角主动背叛；揭露时机按用户自定义安排。"
        assert request.requestId not in runtime.state.pendingUserInputs

        repeated = await runtime.submit_user_input({"requestId": request.requestId, "answers": []}, {})
        assert repeated.plan is not None
        assert repeated.plan.planId == resolution.plan.planId
        assert sum(method == "agent.generate_plan" for method, _, _ in automation.calls) == 0

    asyncio.run(scenario())


def test_preplan_user_input_can_follow_up_once_and_skip_uses_recommended_fallback(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def two_round_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                return {
                    "content": "需要先确认背叛动机。",
                    "shouldPlan": True,
                    "needsClarification": True,
                    "inputRequest": {
                        "title": "背叛方向",
                        "reason": "动机会改变后续计划。",
                        "questions": [{
                            "questionId": "motive",
                            "header": "背叛动机",
                            "prompt": "主角为何背叛？",
                            "options": [
                                {"optionId": "protect", "label": "保护同伴", "description": "牺牲信任换取同伴安全。"},
                                {"optionId": "ambition", "label": "追逐权力", "description": "主动选择更大的个人利益。"},
                            ],
                            "recommendedOptionId": "protect",
                            "recommendationReason": "更贴合既有人物关系。",
                        }],
                    },
                }
            if method == "agent.summarize_user_input":
                return {"summary": params["fallbackSummary"]}
            if method == "agent.generate_user_input_followup":
                assert params["effectiveAnswers"][0]["selectedOptionId"] == "protect"
                return {
                    "needsFollowUp": True,
                    "inputRequest": {
                        "title": "确认最终取舍",
                        "reason": "需要决定保护与代价的优先级。",
                        "questions": [{
                            "questionId": "cost",
                            "header": "最终取舍",
                            "prompt": "保护同伴时，主角愿意承担哪种核心代价？",
                            "options": [
                                {"optionId": "trust", "label": "失去信任", "description": "保住同伴，但关系长期破裂。"},
                                {"optionId": "status", "label": "失去地位", "description": "公开承担责任并失去阵营身份。"},
                            ],
                            "recommendationReason": "关系代价能延续前一轮的选择。",
                        }],
                    },
                }
            if method == "agent.generate_plan":
                decisions = params["userDecisions"]
                assert len(decisions["rounds"]) == 2
                assert decisions["rounds"][1]["answers"][0]["answerKind"] == "skipped"
                assert decisions["rounds"][1]["effectiveAnswers"][0] == {
                    "questionId": "cost",
                    "answerKind": "option",
                    "selectedOptionId": "trust",
                    "customText": None,
                    "source": "recommended_fallback",
                }
                return {
                    "title": "两轮决策后的改写计划",
                    "deliverable": "report",
                    "steps": [{"agent": "writer", "title": "整理改写方案", "tools": []}],
                }
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = two_round_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "把背叛写得更有张力，方向不确定。",
                "role": "writer",
                "conversationId": "conv_two_rounds",
                "messageId": "message-two-rounds",
            },
            {},
        )
        first = response.pendingUserInput
        assert first is not None
        assert first.round == 1 and first.maxRounds == 2
        assert first.sourceMessageId == "message-two-rounds"
        first_resolution = await runtime.submit_user_input({
            "requestId": first.requestId,
            "answers": [{"questionId": "motive", "answerKind": "option", "selectedOptionId": "protect"}],
        }, {})
        assert first_resolution.nextAction == "follow_up_required"
        second = first_resolution.pendingUserInput
        assert second is not None
        assert second.round == 2 and second.previousRequestId == first.requestId
        assert second.inputSessionId == first.inputSessionId
        assert second.sourceMessageId == first.sourceMessageId

        second_resolution = await runtime.submit_user_input({
            "requestId": second.requestId,
            "answers": [{"questionId": "cost", "answerKind": "skipped"}],
        }, {})
        assert second_resolution.nextAction == "plan_created"
        assert second_resolution.plan is not None
        assert second_resolution.effectiveAnswers[0].source == "recommended_fallback"
        assert sum(method == "agent.generate_user_input_followup" for method, _, _ in automation.calls) == 1

    asyncio.run(scenario())


def test_preplan_user_input_dismiss_is_idempotent_and_returns_to_chat(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def clarification_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_chat":
                return {
                    "content": "需要确认。",
                    "shouldPlan": True,
                    "needsClarification": True,
                    "inputRequest": {
                        "title": "方向确认",
                        "reason": "会改变计划。",
                        "questions": [{
                            "questionId": "direction",
                            "header": "方向",
                            "prompt": "选择方向？",
                            "options": [
                                {"optionId": "a", "label": "方向 A", "description": "采用 A。"},
                                {"optionId": "b", "label": "方向 B", "description": "采用 B。"},
                            ],
                            "recommendedOptionId": "a",
                            "recommendationReason": "A 更稳妥。",
                        }],
                    },
                }
            raise AssertionError(f"Unexpected method: {method}")

        automation.invoke = clarification_invoke  # type: ignore[method-assign]
        response = await runtime.chat({"message": "先问我再计划", "conversationId": "conv_dismiss"}, {})
        request = response.pendingUserInput
        assert request is not None
        resolution = await runtime.dismiss_user_input({"requestId": request.requestId}, {})
        assert resolution.status == "dismissed"
        assert resolution.nextAction == "returned_to_chat"
        assert request.requestId not in runtime.state.pendingUserInputs
        repeated = await runtime.dismiss_user_input({"requestId": request.requestId}, {})
        assert repeated.model_dump() == resolution.model_dump()

    asyncio.run(scenario())


def test_chat_keeps_history_and_summary_out_of_main_request(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def history_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.generate_chat"
            assert "history" not in params
            assert "persistentSummary" not in params
            assert params["storageConversationId"] == "stored-conv-history"
            assert params["messageId"] == "current-message"
            assert params["conversationContext"]["currentPlan"]["title"] == "新增觉醒代价"
            return {
                "content": "我会按上面的总结继续。",
                "shouldPlan": True,
                "needsClarification": False,
                "contextCompression": {
                    "applied": True,
                    "historyMessagesSummarized": 18,
                    "historyMessagesOmitted": 0,
                },
                "contextDiagnostics": {
                    "contextVersion": "agent-context-v1",
                    "model": "test-model",
                    "historyMessagesTotal": 28,
                    "historyMessagesKept": 10,
                    "historyMessagesSummarized": 18,
                },
            }

        automation.invoke = history_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "按上面的总结生成草稿。",
                "role": "worldbuilding",
                "approvalMode": "review_required",
                "conversationId": "conv_history",
                "storageConversationId": "stored-conv-history",
                "messageId": "current-message",
                "history": [
                    {"messageId": "history-0", "role": "user", "content": "最早约束：必须保持第一人称。"},
                    *[
                        {
                            "messageId": f"history-{index}",
                            "role": "assistant" if index % 2 else "user",
                            "content": f"中间消息 {index}",
                        }
                        for index in range(1, 27)
                    ],
                    {"messageId": "history-27", "role": "assistant", "content": "最终总结：建议新增觉醒代价设定节点。"},
                ],
                "persistentSummary": {
                    "version": "agent-conversation-summary-v1",
                    "revision": 1,
                    "coveredMessageIds": [],
                },
                "conversationContext": {
                    "currentPlan": {"title": "新增觉醒代价"},
                    "activeRun": {"status": "completed"},
                },
            },
            {"locale": "zh-CN"},
        )
        assert response.suggestedActions == [{"label": "生成计划草稿", "method": "agent.plan"}]
        assert response.contextCompression is not None
        assert response.contextCompression["historyMessagesSummarized"] == 18
        assert response.contextDiagnostics is not None
        assert response.contextDiagnostics["historyMessagesTotal"] == 28
        assert "conversationSummary" not in response.model_dump()
        assert response.assistantMessage.messageId

    asyncio.run(scenario())


def test_worldbuilding_creation_plan_guarantees_creative_draft(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def missing_draft_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "新增世界观大纲节点",
                    "steps": [
                        {"agent": "worldbuilding", "title": "读取现有设定", "tools": ["worldsetting.list"]},
                        {"agent": "worldbuilding", "title": "形成新增设定方案", "tools": []},
                        {"agent": "editor", "title": "检查一致性", "tools": ["plotline.list"]},
                    ],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = missing_draft_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "大纲新增世界观设定部分", "role": "worldbuilding"}, {})
        assert plan.preferredRole == "worldbuilding"
        assert plan.deliverable == "creative_assets_draft"
        draft_steps = [step for step in plan.steps if "creative_assets.generate_draft" in step.tools]
        assert len(draft_steps) == 1
        assert draft_steps[0].agent == "worldbuilding"

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )
        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)
        completed = runtime.state.runs[run.runId]
        assert completed.status == "completed"
        assert completed.draftSessionId == "creative_draft_1"
        assert [artifact.type for artifact in completed.artifacts] == ["creative_assets_draft", "report"]
        assert completed.artifacts[0].reference == {"draftSessionId": "creative_draft_1"}
        report_params = next(params for method, params, _ in automation.calls if method == "agent.generate_report")
        assert report_params["role"] == "worldbuilding"
        assert report_params["deliverable"] == "creative_assets_draft"
        assert "reader" not in {step["agent"] for step in report_params["steps"]}

    asyncio.run(scenario())


def test_planner_rejects_tools_outside_allowlist(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def invalid_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                return {
                    "title": "危险计划",
                    "steps": [{"agent": "writer", "title": "直接写回", "tools": ["chapter.save"]}],
                }
            return await FakeAutomationClient().invoke(method, params, origin, request_id=request_id)

        automation.invoke = invalid_invoke  # type: ignore[method-assign]
        with pytest.raises(ValueError, match="unavailable tool"):
            await runtime.plan({"goal": "修改第三章"}, {})

    asyncio.run(scenario())


def test_register_plan_validates_and_persists_external_review_plan(tmp_path: Path) -> None:
    runtime, _ = create_runtime(tmp_path)
    payload = {
        "planId": "plan_revision_1",
        "threadId": "thread_revision_1",
        "title": "修订人物动机",
        "goal": "根据已接受的问题修订人物动机",
        "requiresApproval": True,
        "preferredRole": "editor",
        "deliverable": "report",
        "steps": [{
            "stepId": "step_revision_1",
            "agent": "editor",
            "title": "读取目标章节",
            "tools": ["chapter.get"],
            "status": "completed",
        }],
    }

    registered = runtime.register_plan({"plan": payload}, {})
    assert registered.planId == "plan_revision_1"
    assert registered.steps[0].status == "pending"
    assert runtime.state.plans[registered.planId].title == "修订人物动机"
    assert runtime.register_plan({"plan": registered.model_dump()}, {}).planId == registered.planId

    invalid = {
        **payload,
        "planId": "plan_revision_invalid",
        "steps": [{**payload["steps"][0], "stepId": "step_invalid", "tools": ["chapter.save"]}],
    }
    with pytest.raises(ValueError, match="unknown tools"):
        runtime.register_plan({"plan": invalid}, {})
    with pytest.raises(ValueError, match="must require user approval"):
        runtime.register_plan({"plan": {**payload, "planId": "plan_external_auto", "requiresApproval": False}}, {})


def test_revise_plan_preserves_plan_identity_and_existing_step_ids(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        plan = await runtime.plan({"goal": "续写下一段", "role": "writer"}, {})
        original_plan_id = plan.planId
        original_thread_id = plan.threadId
        original_first_step_id = plan.steps[0].stepId

        revised = await runtime.revise_plan(
            {
                "planId": plan.planId,
                "revision": "增加读者视角的追更欲望检查",
                "role": "reader",
            },
            {"locale": "zh-CN"},
        )

        assert revised.planId == original_plan_id
        assert revised.threadId == original_thread_id
        assert revised.steps[0].stepId == original_first_step_id
        assert revised.steps[1].stepId != plan.steps[1].stepId
        assert revised.steps[1].agent == "reader"
        method, params, _ = automation.calls[-1]
        assert method == "agent.revise_plan"
        assert params["revision"] == "增加读者视角的追更欲望检查"

    asyncio.run(scenario())


def test_explicit_chapter_scope_overrides_model_and_survives_revision(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)

        async def scoped_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            automation.calls.append((method, params, origin))
            if method == "agent.generate_plan":
                return {
                    "title": "跨章编辑审核",
                    "deliverable": "expert_report",
                    "steps": [{
                        "agent": "editor",
                        "title": "审核模型猜测的范围",
                        "tools": [],
                        "toolchain": {
                            "id": "editor.range_review",
                            "version": "1.0.0",
                            "input": {"kind": "selected_chapters", "chapterIds": ["model_chapter"]},
                        },
                    }],
                }
            if method == "agent.revise_plan":
                first_step = params["currentPlan"]["steps"][0]
                return {
                    "title": "修订后的跨章编辑审核",
                    "deliverable": "expert_report",
                    "steps": [{
                        "stepId": first_step["stepId"],
                        "agent": "editor",
                        "title": "再次审核模型猜测的范围",
                        "tools": [],
                        "toolchain": {
                            "id": "editor.range_review",
                            "version": "1.0.0",
                            "input": {"kind": "novel", "chapterIds": []},
                        },
                    }],
                }
            return await FakeAutomationClient().invoke(method, params, origin, request_id=request_id)

        automation.invoke = scoped_invoke  # type: ignore[method-assign]
        explicit_scope = {
            "kind": "selected_chapters",
            "chapterIds": ["chapter_2", "chapter_4"],
            "anchorChapterId": "chapter_4",
            "processingMode": "detailed",
        }
        plan = await runtime.plan(
            {
                "goal": "审核选择的两章",
                "role": "editor",
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "chapterScope": explicit_scope,
            },
            {"locale": "zh-CN"},
        )
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.input["kind"] == "selected_chapters"
        assert plan.steps[0].toolchain.input["chapterIds"] == ["chapter_2", "chapter_4"]
        assert plan.steps[0].toolchain.input["anchorChapterId"] == "chapter_4"

        revised = await runtime.revise_plan(
            {
                "planId": plan.planId,
                "revision": "加强动机检查",
                "role": "editor",
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "chapterScope": explicit_scope,
            },
            {"locale": "zh-CN"},
        )
        assert revised.steps[0].toolchain is not None
        assert revised.steps[0].toolchain.input["kind"] == "selected_chapters"
        assert revised.steps[0].toolchain.input["chapterIds"] == ["chapter_2", "chapter_4"]

    asyncio.run(scenario())


def test_resolved_operation_target_survives_revision_and_changes_only_when_explicit(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def authoritative_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
            **kwargs: Any,
        ) -> Any:
            if method == "volume.list":
                automation.calls.append((method, params, origin))
                return [
                    {
                        "id": "volume_1",
                        "title": "第一卷",
                        "order": 1,
                        "chapters": [
                            {"id": "chapter_1", "title": "雨夜来电", "order": 1, "wordCount": 2100, "hasContent": True},
                            {"id": "chapter_2", "title": "白色房间", "order": 2, "wordCount": 3200, "hasContent": True},
                        ],
                    },
                    {
                        "id": "volume_3",
                        "title": "第三卷",
                        "order": 3,
                        "chapters": [
                            {"id": "chapter_9", "title": "终局", "order": 1, "wordCount": 2800, "hasContent": True},
                        ],
                    },
                ]
            return await original_invoke(method, params, origin, request_id=request_id, **kwargs)

        automation.invoke = authoritative_invoke  # type: ignore[method-assign]
        catalog = [
            {"chapterId": "chapter_1", "title": "雨夜来电", "chapterOrder": 1, "volumeId": "volume_1", "volumeTitle": "第一卷", "volumeOrder": 1},
            {"chapterId": "chapter_2", "title": "白色房间", "chapterOrder": 2, "volumeId": "volume_1", "volumeTitle": "第一卷", "volumeOrder": 1},
            {"chapterId": "chapter_9", "title": "终局", "chapterOrder": 1, "volumeId": "volume_3", "volumeTitle": "第三卷", "volumeOrder": 3},
        ]
        response = await runtime.chat(
            {
                "message": "续写最后一章",
                "role": "writer",
                "approvalMode": "review_required",
                "conversationId": "conv_revision_target",
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "volumeId": "volume_1",
                "chapterCatalog": catalog,
            },
            {"locale": "zh-CN"},
        )
        assert response.intentDecision is not None
        plan = await runtime.plan(
            {
                "goal": "续写最后一章",
                "role": "writer",
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "volumeId": "volume_1",
                "chapterCatalog": catalog,
                "intentDecision": response.intentDecision.model_dump(),
            },
            {"locale": "zh-CN"},
        )
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.input["chapterId"] == "chapter_9"

        async def revise_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            automation.calls.append((method, params, origin))
            assert method == "agent.revise_plan"
            first_step = params["currentPlan"]["steps"][0]
            return {
                "title": "修订后的续写计划",
                "deliverable": "chapter_draft",
                "steps": [{
                    "stepId": first_step["stepId"],
                    "agent": "writer",
                    "title": "按新节奏生成草稿",
                    "tools": [],
                    "toolchain": {
                        "id": "chapter.continuation",
                        "version": "1.0.0",
                        "input": {"chapterId": "chapter_2"},
                    },
                }],
            }

        automation.invoke = revise_invoke  # type: ignore[method-assign]
        preserved = await runtime.revise_plan(
            {
                "planId": plan.planId,
                "revision": "把节奏改得更紧凑",
                "role": "writer",
                "chapterCatalog": catalog,
            },
            {"locale": "zh-CN"},
        )
        assert preserved.steps[0].toolchain is not None
        assert preserved.steps[0].toolchain.input["chapterId"] == "chapter_9"
        assert preserved.steps[0].toolchain.input["_resolvedTarget"]["selector"] == "last_in_novel"

        changed = await runtime.revise_plan(
            {
                "planId": plan.planId,
                "revision": "把写作目标明确改成第二章",
                "role": "writer",
                "chapterCatalog": catalog,
            },
            {"locale": "zh-CN"},
        )
        assert changed.steps[0].toolchain is not None
        assert changed.steps[0].toolchain.input["chapterId"] == "chapter_2"
        assert changed.steps[0].toolchain.input["_resolvedTarget"]["selector"] == "novel_chapter_ordinal"

    asyncio.run(scenario())


def test_chat_validates_stale_catalog_before_resolving_last_chapter(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def hydrated_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
            **kwargs: Any,
        ) -> Any:
            if method == "volume.list":
                automation.calls.append((method, params, origin))
                return [
                    {
                        "id": "volume_1",
                        "title": "第一卷",
                        "order": 1,
                        "chapters": [
                            {"id": "chapter_1", "title": "雨夜来电", "order": 1, "wordCount": 2100, "hasContent": True},
                            {"id": "chapter_2", "title": "白色房间", "order": 2, "wordCount": 3200, "hasContent": True},
                        ],
                    },
                    {
                        "id": "volume_3",
                        "title": "第三卷",
                        "order": 3,
                        "chapters": [{"id": "chapter_9", "title": "终局", "order": 1, "wordCount": 2800, "hasContent": True}],
                    },
                ]
            if method == "agent.generate_chat":
                automation.calls.append((method, params, origin))
                operation_target = params["selectionContext"]["operationTarget"]
                assert operation_target["chapterId"] == "chapter_9"
                assert operation_target["hasContent"] is True
                assert operation_target["wordCount"] == 2800
                assert operation_target["structuralLast"]["chapterId"] == "chapter_9"
                return {
                    "content": "最后一章已经完整收束，我会以它为锚点新建下一章。",
                    "shouldPlan": True,
                    "needsClarification": False,
                    "requestedOperations": ["chapter.create"],
                    "deliverable": "chapter_draft_batch",
                    "confidence": 0.88,
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = hydrated_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "帮我续写最后一章",
                "role": "writer",
                "approvalMode": "review_required",
                "conversationId": "conv_hydrated_last_chapter",
                "novelId": "novel_1",
                "chapterId": "chapter_2",
                "volumeId": "volume_1",
                "chapterCatalog": [
                    {
                        "chapterId": "chapter_2",
                        "title": "白色房间",
                        "chapterOrder": 2,
                        "volumeId": "volume_1",
                        "volumeTitle": "第一卷",
                        "volumeOrder": 1,
                    },
                ],
            },
            {"locale": "zh-CN"},
        )

        assert response.intentDecision is not None
        assert response.intentDecision.route == "plan"
        assert response.intentDecision.operations[0].type == "chapter.create"
        assert response.intentDecision.operations[0].target.id == "chapter_9"
        assert response.intentDecision.operations[0].target.selector == "last_in_novel"
        assert any(method == "volume.list" for method, _, _ in automation.calls)

    asyncio.run(scenario())


def test_invalid_unstructured_clarification_is_non_fatal(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def malformed_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
            **kwargs: Any,
        ) -> Any:
            if method == "agent.generate_chat":
                automation.calls.append((method, params, origin))
                return {
                    "content": "需要先确认方向。",
                    "shouldPlan": False,
                    "needsClarification": True,
                    "inputRequest": None,
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = malformed_invoke  # type: ignore[method-assign]
        response = await runtime.chat(
            {
                "message": "大纲新增一部分",
                "role": "writer",
                "approvalMode": "review_required",
                "conversationId": "conv_invalid_clarification",
                "novelId": "novel_1",
                "chapterId": "chapter_1",
            },
            {"locale": "zh-CN"},
        )

        assert response.awaitingUserInput is False
        assert response.pendingUserInput is None
        assert response.intentDecision is not None
        assert response.intentDecision.route == "respond"
        assert "INVALID_CLARIFICATION_DOWNGRADED" in response.intentDecision.reasonCodes
        assert "换一种更具体的方式" in response.assistantMessage.content

    asyncio.run(scenario())


def test_explicit_rewrite_range_becomes_exact_batch_write_target(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, _ = create_runtime(tmp_path)
        catalog = [
            {"chapterId": f"chapter_{index}", "title": f"第{index}章", "chapterOrder": index,
             "volumeId": "volume_1", "volumeTitle": "第一卷", "volumeOrder": 1}
            for index in range(1, 6)
        ]
        response = await runtime.chat(
            {
                "message": "改写第二到第四章",
                "role": "writer",
                "approvalMode": "review_required",
                "conversationId": "conv_rewrite_range",
                "novelId": "novel_1",
                "chapterId": "chapter_1",
                "volumeId": "volume_1",
                "chapterCatalog": catalog,
            },
            {"locale": "zh-CN"},
        )
        assert response.intentDecision is not None
        assert response.intentDecision.operations[0].target.ids == ["chapter_2", "chapter_3", "chapter_4"]

        plan = await runtime.plan(
            {
                "goal": "改写第二到第四章",
                "role": "writer",
                "novelId": "novel_1",
                "chapterId": "chapter_1",
                "volumeId": "volume_1",
                "chapterCatalog": catalog,
                "intentDecision": response.intentDecision.model_dump(),
            },
            {"locale": "zh-CN"},
        )
        assert plan.steps[0].toolchain is not None
        assert plan.steps[0].toolchain.id == "chapter.batch_rewrite"
        assert plan.steps[0].toolchain.input["chapterIds"] == ["chapter_2", "chapter_3", "chapter_4"]
        assert plan.steps[0].toolchain.input["chapterId"] == "chapter_2"
        assert plan.steps[0].toolchain.input["chapterCount"] == 3

    asyncio.run(scenario())


def test_full_run_resumes_from_approval_and_creates_draft(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def quality_plan_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "章节打磨计划",
                    "steps": [
                        {"agent": "supervisor", "title": "读取章节", "tools": ["chapter.get"]},
                        {"agent": "editor", "title": "分析节奏", "tools": ["rag.ask"]},
                        {"agent": "writer", "title": "生成草稿", "tools": ["chapter.generate_draft"]},
                    ],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = quality_plan_invoke  # type: ignore[method-assign]
        install_durable_draft_protocol(automation)
        plan = await runtime.plan({"goal": "打磨第三章", "role": "team"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {
                    "approved": True,
                    "approvedStepIds": [step.stepId for step in plan.steps],
                },
            },
            {"locale": "zh-CN"},
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "waiting_user_input":
                break
            await asyncio.sleep(0.01)

        waiting_run = runtime.state.runs[run.runId]
        assert waiting_run.status == "waiting_user_input"
        assert waiting_run.pendingUserInput is not None
        assert waiting_run.pendingApproval is not None
        checkpoint_id = str(waiting_run.pendingApproval["checkpointId"])
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": checkpoint_id,
                "selectedOptionIds": ["current_chapter"],
            }
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        completed_run = runtime.state.runs[run.runId]
        assert completed_run.status == "completed"
        assert completed_run.draftSessionId == "draft_1"
        assert [artifact.type for artifact in completed_run.artifacts] == ["chapter_draft", "report"]
        assert completed_run.artifacts[0].reference == {"draftSessionId": "draft_1"}
        assert "最终建议" in str(completed_run.artifacts[1].content)
        assert sum(event.type == "artifact_created" for event in completed_run.events) == 2
        milestones = [
            event.type for event in completed_run.events
            if event.type in {"user_input_required", "draft_created", "run_completed"}
            or (event.type == "message" and event.payload.get("kind") == "final_report")
        ]
        assert milestones == ["user_input_required", "draft_created", "message", "run_completed"]
        final_report_event = next(
            event for event in completed_run.events
            if event.type == "message" and event.payload.get("kind") == "final_report"
        )
        assert "审阅已完成" in str(final_report_event.payload.get("content"))
        assert "最终建议" not in str(final_report_event.payload.get("content"))
        assert final_report_event.payload.get("reportArtifactId") == completed_run.artifacts[1].artifactId
        rag_call = next(params for method, params, _ in automation.calls if method == "rag.ask")
        assert rag_call["analysisScope"] == "current_chapter"
        assert rag_call["maxEvidenceItems"] == 8
        report_call = next(params for method, params, _ in automation.calls if method == "agent.generate_report")
        assert any(finding["toolName"] == "rag.ask" for finding in report_call["findings"])

    asyncio.run(scenario())


def test_low_confidence_checkpoint_can_skip_draft_generation(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def low_confidence_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.generate_plan":
                automation.calls.append((method, params, origin))
                return {
                    "title": "低置信度章节检查",
                    "steps": [
                        {"agent": "editor", "title": "分析章节", "tools": ["rag.ask"]},
                        {"agent": "writer", "title": "生成草稿", "tools": ["chapter.generate_draft"]},
                    ],
                }
            if method == "rag.ask":
                automation.calls.append((method, params, origin))
                return {
                    "answer": "现有资料不足以形成稳定判断。",
                    "confidence": "low",
                    "warnings": ["向量索引没有匹配结果"],
                    "evidence": [],
                }
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = low_confidence_invoke  # type: ignore[method-assign]
        plan = await runtime.plan({"goal": "检查第三章"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        for _ in range(2000):
            pending = runtime.state.runs[run.runId].pendingApproval
            if pending and pending.get("checkpointType") == "analysis_scope":
                break
            await asyncio.sleep(0.01)
        scope_checkpoint = runtime.state.runs[run.runId].pendingApproval
        assert scope_checkpoint is not None
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": scope_checkpoint["checkpointId"],
                "selectedOptionIds": ["current_chapter"],
            }
        )

        for _ in range(2000):
            pending = runtime.state.runs[run.runId].pendingApproval
            if pending and pending.get("checkpointType") == "evidence_quality":
                break
            await asyncio.sleep(0.01)
        evidence_checkpoint = runtime.state.runs[run.runId].pendingApproval
        assert evidence_checkpoint is not None
        assert evidence_checkpoint["allowFreeText"] is False
        await runtime.submit_approval(
            {
                "runId": run.runId,
                "checkpointId": evidence_checkpoint["checkpointId"],
                "selectedOptionIds": ["report_only"],
            }
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        completed_run = runtime.state.runs[run.runId]
        assert completed_run.status == "completed"
        assert completed_run.draftSessionId is None
        assert not any(method == "chapter.generate_draft" for method, _, _ in automation.calls)
        approval_types = [
            event.payload["questions"][0]["questionId"]
            for event in completed_run.events
            if event.type == "user_input_required"
        ]
        assert approval_types == ["analysis_scope", "evidence_quality"]
        skipped = [
            event for event in completed_run.events
            if event.type == "tool_result" and event.status == "skipped"
        ]
        assert skipped and skipped[-1].payload["reason"] == "report_only"

    asyncio.run(scenario())


def test_creative_direction_choice_is_injected_into_draft_intent(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke

        async def direction_invoke(method: str, params: dict[str, Any], origin: str, request_id: str | None = None) -> Any:
            if method == "agent.detect_creative_direction":
                automation.calls.append((method, params, origin))
                return {
                    "requiresDecision": True,
                    "title": "章末方向确认",
                    "reason": "两个方向会改变下一章的起点。",
                    "questions": [
                        {
                            "questionId": "ending_direction",
                            "header": "章末方向",
                            "prompt": "章末更偏向胜利还是危机？",
                            "recommendationReason": "危机升级更适合续写目标。",
                            "options": [
                                {"optionId": "model_crisis", "label": "危机升级", "description": "用更强阻力制造追更钩子。"},
                                {"optionId": "model_victory", "label": "阶段性胜利", "description": "先兑现本章目标。"},
                            ],
                        },
                        {
                            "questionId": "pov_distance",
                            "header": "叙事距离",
                            "prompt": "危机揭露时采用哪种叙事距离？",
                            "recommendationReason": "贴近感官更容易放大危机感。",
                            "options": [
                                {"optionId": "close", "label": "贴近主角", "description": "紧跟主角感官与即时判断。"},
                                {"optionId": "distant", "label": "拉远观察", "description": "从全局展示危机扩散。"},
                            ],
                        },
                    ],
                }
            if method == "agent.summarize_user_input":
                automation.calls.append((method, params, origin))
                return {"summary": "采用阶段性胜利，并拉远观察。"}
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = direction_invoke  # type: ignore[method-assign]
        install_durable_draft_protocol(automation)
        plan = await runtime.plan({"goal": "续写下一段"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        for _ in range(2000):
            pending = runtime.state.runs[run.runId].pendingApproval
            if pending and pending.get("checkpointType") == "creative_direction":
                break
            await asyncio.sleep(0.01)
        request = runtime.state.runs[run.runId].pendingUserInput
        assert request is not None
        assert len(request.questions) == 2
        assert [option.optionId for option in request.questions[0].options] == ["model_crisis", "model_victory"]
        await runtime.submit_user_input(
            {
                "requestId": request.requestId,
                "answers": [
                    {
                        "questionId": "ending_direction",
                        "answerKind": "option",
                        "selectedOptionId": "model_crisis",
                    },
                    {
                        "questionId": "pov_distance",
                        "answerKind": "custom",
                        "customText": "贴近主角感官，但偶尔切到追兵视角。",
                    },
                ],
            },
            {},
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        draft_params = next(params for method, params, _ in automation.calls if method == "chapter.generate_draft")
        assert "用户确认的创作方向" in draft_params["userIntent"]
        assert "危机升级" in draft_params["userIntent"]
        assert "贴近主角感官，但偶尔切到追兵视角" in draft_params["userIntent"]
        assert "阶段性胜利" not in draft_params["userIntent"]
        assert "model_crisis" not in draft_params["userIntent"]
        decision = runtime.state.runs[run.runId].userInputResponses[-1]
        assert decision["answers"][0]["selectedOptionId"] == "model_crisis"
        assert decision["understandingSummary"] == "采用阶段性胜利，并拉远观察。"

    asyncio.run(scenario())


def test_cancel_requests_durable_operation_stop_without_creating_draft(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        original_invoke = automation.invoke
        draft_started = asyncio.Event()

        async def slow_draft_invoke(
            method: str,
            params: dict[str, Any],
            origin: str,
            request_id: str | None = None,
        ) -> Any:
            if method == "chapter.generate_draft":
                automation.calls.append((method, params, origin))
                if request_id:
                    automation.request_ids.append(request_id)
                draft_started.set()
                await asyncio.Event().wait()
            return await original_invoke(method, params, origin, request_id=request_id)

        automation.invoke = slow_draft_invoke  # type: ignore[method-assign]
        install_durable_draft_protocol(automation)
        plan = await runtime.plan({"goal": "续写下一段"}, {})
        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "第三章正文",
                "approval": {"approved": True, "approvedStepIds": [step.stepId for step in plan.steps]},
            },
            {},
        )

        await asyncio.wait_for(draft_started.wait(), timeout=1)
        for _ in range(2000):
            if run.runId in runtime._operation_watch_timers:
                break
            await asyncio.sleep(0.01)
        assert run.runId in runtime._operation_watch_timers, json.dumps([
            (event.type, event.payload) for event in runtime.state.runs[run.runId].events[-10:]
        ], ensure_ascii=False, default=str)
        cancelled = await runtime.cancel({"runId": run.runId})
        assert cancelled.status in {"cancelling", "cancelled"}

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "cancelled":
                break
            await asyncio.sleep(0.01)

        final_run = runtime.state.runs[run.runId]
        assert final_run.status == "cancelled"
        assert final_run.draftSessionId is None
        assert automation.cancelled_request_ids == []
        assert any(method == "chapter.draft.cancel" for method, _, _ in automation.calls)
        assert any(event.type == "run_cancelled" for event in final_run.events)
        assert not any(event.type == "run_failed" for event in final_run.events)
        invocation = runtime.store.list_invocations(run.runId)[0]
        assert invocation.status == "operation_pending"
        assert invocation.error is None

    asyncio.run(scenario())


def test_execute_plan_only_runs_approved_steps(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        plan = await runtime.plan(
            {"goal": "续写下一段", "novelId": "novel_1", "chapterId": "chapter_3"},
            {},
        )
        plan.deliverable = "report"
        approved_step = plan.steps[0]
        skipped_step = plan.steps[1]

        run = await runtime.execute_plan(
            {
                "planId": plan.planId,
                "novelId": "novel_1",
                "chapterId": "chapter_3",
                "currentContent": "正文",
                "approval": {"approved": True, "approvedStepIds": [approved_step.stepId]},
            },
            {},
        )

        for _ in range(2000):
            if runtime.state.runs[run.runId].status == "completed":
                break
            await asyncio.sleep(0.01)

        assert runtime.state.runs[run.runId].status == "completed"
        assert approved_step.status == "completed"
        assert skipped_step.status == "skipped"
        execution_methods = [method for method, _, _ in automation.calls if not method.startswith("agent.generate_")]
        assert execution_methods == ["chapter.get"]

    asyncio.run(scenario())


def test_analysis_scope_changes_rag_request(tmp_path: Path) -> None:
    async def scenario() -> None:
        runtime, automation = create_runtime(tmp_path)
        run = AgentRun(
            runId=new_id("run"),
            threadId=new_id("thread"),
            planId=new_id("plan"),
            status="running",
            approvalResponses=[
                {
                    "checkpointType": "analysis_scope",
                    "selectedOptionIds": ["volume_structure"],
                    "freeText": "重点检查伏笔回收",
                }
            ],
        )

        await runtime._invoke_tool(
            run,
            "rag.ask",
            "提高追更欲望",
            "novel_1",
            None,
            "chapter_3",
            "正文",
            "zh-CN",
        )

        method, params, _ = automation.calls[-1]
        assert method == "rag.ask"
        assert params["analysisScope"] == "volume_structure"
        assert params["maxEvidenceItems"] == 24
        assert "当前卷的整体结构" in params["question"]
        assert "重点检查伏笔回收" in params["question"]

    asyncio.run(scenario())


def test_event_stream_replays_terminal_event(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = AgentStateStore(tmp_path)
        event_bus = AgentEventBus(store)
        run_id = new_id("run")
        await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_started")
        )
        terminal = await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_completed")
        )

        replayed = []
        async for event in event_bus.subscribe(run_id, after_sequence=0):
            replayed.append(event)

        assert [event.type for event in replayed] == ["run_started", "run_completed"]
        assert replayed[-1].sequence == terminal.sequence

    asyncio.run(scenario())


def test_sse_endpoint_authenticates_and_replays_after_sequence(tmp_path: Path) -> None:
    store = AgentStateStore(tmp_path)
    event_bus = AgentEventBus(store)
    automation = FakeAutomationClient()
    runtime = NovelAgentRuntime(store, automation, event_bus)
    run_id = new_id("run")

    async def seed_events() -> tuple[AgentRunEvent, AgentRunEvent]:
        first = await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_started")
        )
        terminal = await event_bus.append(
            AgentRunEvent(eventId=new_id("evt"), runId=run_id, type="run_completed")
        )
        return first, terminal

    first, terminal = asyncio.run(seed_events())
    app = build_app(runtime, "test-token")
    with TestClient(app) as client:
        unauthorized = client.get(f"/events/{run_id}")
        assert unauthorized.status_code == 401

        response = client.get(
            f"/events/{run_id}?afterSequence={first.sequence}",
            headers={"Authorization": "Bearer test-token"},
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    data_lines = [line.removeprefix("data: ") for line in response.text.splitlines() if line.startswith("data: ")]
    assert len(data_lines) == 1
    payload = json.loads(data_lines[0])
    assert payload["eventId"] == terminal.eventId
    assert payload["sequence"] == terminal.sequence
    assert payload["type"] == "run_completed"
