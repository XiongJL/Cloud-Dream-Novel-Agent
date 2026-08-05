from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AgentToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    read_only: bool
    timeout_seconds: float = 90
    idempotent: bool = False


def _object_schema(
    properties: dict[str, Any] | None = None,
    required: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties or {},
        "required": required or [],
        "additionalProperties": True,
    }


_ID = {"type": "string", "minLength": 1}

AGENT_TOOL_MANIFEST: tuple[AgentToolDefinition, ...] = (
    AgentToolDefinition("novel.list", "列出当前可用小说。", _object_schema(), True),
    AgentToolDefinition("volume.list", "列出小说的卷和章节概要。", _object_schema({"novelId": _ID}, ["novelId"]), True),
    AgentToolDefinition(
        "chapter.list",
        "列出指定卷下的章节；长范围分析可使用 offset/limit 分批读取。",
        _object_schema(
            {
                "volumeId": _ID,
                "offset": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                "includeContent": {"type": "boolean"},
            },
            ["volumeId"],
        ),
        True,
    ),
    AgentToolDefinition("chapter.get", "读取指定章节内容。", _object_schema({"chapterId": _ID}, ["chapterId"]), True),
    AgentToolDefinition(
        "attachment.list",
        "列出当前小说、当前会话中用户已经发送的文档附件；只返回元数据。",
        _object_schema({"novelId": _ID, "conversationId": _ID}, ["novelId", "conversationId"]),
        True,
    ),
    AgentToolDefinition(
        "attachment.get",
        "兼容接口：按字符窗口读取当前会话附件。优先使用 attachment.read；同时接受 offset/limit 或 startOffset/endOffset。",
        _object_schema(
            {
                "novelId": _ID,
                "conversationId": _ID,
                "attachmentId": _ID,
                "offset": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 12000},
                "startOffset": {"type": "integer", "minimum": 0},
                "endOffset": {"type": "integer", "minimum": 0},
            },
            ["novelId", "conversationId", "attachmentId"],
        ),
        True,
    ),
    AgentToolDefinition(
        "attachment.read",
        "按通用选择器读取附件。可按任意标题章节、字符范围、页码范围或块范围定位；长范围会按块边界分页并返回 nextSelector。",
        _object_schema(
            {
                "novelId": _ID,
                "conversationId": _ID,
                "attachmentId": _ID,
                "selector": {
                    "oneOf": [
                        _object_schema(
                            {
                                "kind": {"type": "string", "const": "section"},
                                "title": {"type": "string", "minLength": 1, "maxLength": 200},
                                "occurrence": {"type": "integer", "minimum": 1},
                                "includeSubsections": {"type": "boolean"},
                            },
                            ["kind", "title"],
                        ),
                        _object_schema(
                            {
                                "kind": {"type": "string", "const": "offset_range"},
                                "startOffset": {"type": "integer", "minimum": 0},
                                "endOffset": {"type": "integer", "minimum": 0},
                            },
                            ["kind", "startOffset", "endOffset"],
                        ),
                        _object_schema(
                            {
                                "kind": {"type": "string", "const": "page_range"},
                                "startPage": {"type": "integer", "minimum": 1},
                                "endPage": {"type": "integer", "minimum": 1},
                            },
                            ["kind", "startPage", "endPage"],
                        ),
                        _object_schema(
                            {
                                "kind": {"type": "string", "const": "block_range"},
                                "startBlockId": _ID,
                                "endBlockId": _ID,
                            },
                            ["kind", "startBlockId"],
                        ),
                    ],
                },
            },
            ["novelId", "conversationId", "attachmentId", "selector"],
        ),
        True,
    ),
    AgentToolDefinition(
        "attachment.outline",
        "读取当前会话附件的标题、页码和块范围目录，不返回完整正文。",
        _object_schema(
            {"novelId": _ID, "conversationId": _ID, "attachmentId": _ID},
            ["novelId", "conversationId", "attachmentId"],
        ),
        True,
    ),
    AgentToolDefinition(
        "attachment.search",
        "在当前会话已发送的附件中搜索关键词，返回少量命中片段和字符偏移；需要完整范围时调用 attachment.read。",
        _object_schema(
            {
                "novelId": _ID,
                "conversationId": _ID,
                "query": {"type": "string", "minLength": 1, "maxLength": 200},
                "attachmentId": _ID,
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            ["novelId", "conversationId", "query"],
        ),
        True,
    ),
    AgentToolDefinition(
        "draft.get",
        "读取指定待审核草稿及其当前版本。",
        _object_schema({"draftSessionId": _ID}, ["draftSessionId"]),
        True,
    ),
    AgentToolDefinition(
        "chapter.scope_context.build",
        "按已批准范围装配有序章节、摘要、实体、情节线、版本快照和覆盖统计。",
        _object_schema(
            {
                "scopeId": {"type": "string"},
                "novelId": _ID,
                "kind": {
                    "type": "string",
                    "enum": ["current_chapter", "selected_chapters", "chapter_range", "current_volume", "novel"],
                },
                "volumeId": {"type": "string"},
                "chapterId": {"type": "string"},
                "chapterIds": {"type": "array", "items": _ID},
                "anchorChapterId": {"type": "string"},
                "processingMode": {"type": "string", "enum": ["detailed", "batched"]},
                "currentContent": {"type": "string"},
                "goal": {"type": "string"},
                "locale": {"type": "string"},
                "batchSize": {"type": "integer", "minimum": 1, "maximum": 10},
                "maxDetailedChapters": {"type": "integer", "minimum": 1, "maximum": 20},
                "maxEstimatedTokens": {"type": "integer", "minimum": 4000, "maximum": 200000},
            },
            ["novelId"],
        ),
        True,
        90,
    ),
    AgentToolDefinition(
        "chapter.continuation_context.build",
        "装配按作品顺序排列的续写上下文、分层正文与摘要、当前编辑内容和版本快照。",
        _object_schema(
            {
                "novelId": _ID,
                "chapterId": _ID,
                "currentContent": {"type": "string"},
                "contextChapterCount": {"type": "integer", "minimum": 1, "maximum": 20},
                "recentRawChapterCount": {"type": "integer", "minimum": 1, "maximum": 3},
                "targetLength": {"type": "integer", "minimum": 100},
                "style": {"type": "string"},
                "tone": {"type": "string"},
                "pace": {"type": "string"},
                "locale": {"type": "string"},
            },
            ["novelId", "chapterId"],
        ),
        True,
        90,
    ),
    AgentToolDefinition(
        "rag.ask",
        "检索项目知识库并返回带证据的回答。",
        _object_schema(
            {
                "novelId": _ID,
                "question": {"type": "string", "minLength": 1},
                "chapterId": {"type": "string"},
                "locale": {"type": "string"},
                "maxEvidenceItems": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            ["novelId", "question"],
        ),
        True,
    ),
    AgentToolDefinition(
        "search.query",
        "在当前小说中执行全文搜索。",
        _object_schema(
            {
                "novelId": _ID,
                "keyword": {"type": "string", "minLength": 1},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0},
            },
            ["novelId", "keyword"],
        ),
        True,
    ),
    AgentToolDefinition("plotline.list", "列出小说情节线与情节点。", _object_schema({"novelId": _ID}, ["novelId"]), True),
    AgentToolDefinition("character.list", "列出小说角色。", _object_schema({"novelId": _ID}, ["novelId"]), True),
    AgentToolDefinition("item.list", "列出小说物品与技能。", _object_schema({"novelId": _ID}, ["novelId"]), True),
    AgentToolDefinition("worldsetting.list", "列出小说世界观设定。", _object_schema({"novelId": _ID}, ["novelId"]), True),
    AgentToolDefinition("map.list", "列出小说地图。", _object_schema({"novelId": _ID}, ["novelId"]), True),
    AgentToolDefinition(
        "agent.generate_chapter_beats",
        "根据已装配上下文为连续多章生成可审批的章节节拍。",
        _object_schema(
            {
                "novelId": _ID,
                "chapterId": _ID,
                "goal": {"type": "string", "minLength": 1},
                "chapterCount": {"type": "integer", "minimum": 1, "maximum": 5},
                "locale": {"type": "string"},
                "context": {"type": "object"},
                "taskMode": {"type": "string", "enum": ["sequence_continuation", "batch_rewrite"]},
                "targetChapterIds": {"type": "array", "minItems": 1, "maxItems": 5, "items": _ID},
                "revisionInstruction": {"type": "string", "minLength": 1, "maxLength": 4000},
                "previousBeats": {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "object"}},
            },
            ["novelId", "chapterId", "goal", "chapterCount"],
        ),
        True,
        180,
    ),
    AgentToolDefinition(
        "draft.batch.get",
        "读取父子章节草稿批次及其节拍和状态。",
        _object_schema({"draftBatchId": _ID}, ["draftBatchId"]),
        True,
    ),
    AgentToolDefinition(
        "draft.batch.create",
        "创建等待节拍审批的父子章节草稿批次。",
        _object_schema(
            {
                "novelId": _ID,
                "volumeId": _ID,
                "anchorChapterId": _ID,
                "mode": {"type": "string", "enum": ["sequence_continuation", "batch_rewrite"]},
                "insertionMode": {"type": "string", "enum": ["after_anchor", "volume_end"]},
                "beats": {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "object"}},
                "sourceSnapshot": {"type": "array", "items": {"type": "object"}},
                "targetChapterIds": {"type": "array", "minItems": 1, "maxItems": 5, "items": _ID},
                "runId": _ID,
            },
            ["novelId", "volumeId", "anchorChapterId", "mode", "beats"],
        ),
        False,
        30,
    ),
    AgentToolDefinition(
        "draft.batch.update_outline",
        "使用乐观锁保存新一版父子章节节拍。",
        _object_schema(
            {
                "draftBatchId": _ID,
                "version": {"type": "integer", "minimum": 1},
                "beats": {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "object"}},
            },
            ["draftBatchId", "version", "beats"],
        ),
        False,
        30,
    ),
    AgentToolDefinition(
        "draft.batch.approve_outline",
        "确认批次章节节拍并允许顺序生成正文。",
        _object_schema(
            {
                "draftBatchId": _ID,
                "version": {"type": "integer", "minimum": 1},
                "outlineRevision": {"type": "integer", "minimum": 1},
                "approvedBy": {"type": "string"},
            },
            ["draftBatchId", "version", "outlineRevision"],
        ),
        False,
        30,
    ),
    AgentToolDefinition(
        "draft.batch.commit_prefix",
        "将连续且非过期的章节草稿前缀事务性写入作品；范围冲突时整批零写入。",
        _object_schema(
            {
                "draftBatchId": _ID,
                "version": {"type": "integer", "minimum": 1},
                "prefixLength": {"type": "integer", "minimum": 1, "maximum": 5},
                "insertionMode": {"type": "string", "enum": ["after_anchor", "volume_end"]},
            },
            ["draftBatchId", "version", "prefixLength"],
        ),
        False,
        60,
    ),
    AgentToolDefinition(
        "draft.batch.prepare_regeneration",
        "回滚指定章节及其后续草稿，递增生成修订号，并返回可复用的前缀草稿。",
        _object_schema(
            {
                "draftBatchId": _ID,
                "version": {"type": "integer", "minimum": 1},
                "fromChildIndex": {"type": "integer", "minimum": 0, "maximum": 4},
                "runId": _ID,
            },
            ["draftBatchId", "version", "runId"],
        ),
        False,
        30,
    ),
    AgentToolDefinition(
        "draft.batch.mark_failed",
        "记录批次子章节的生成失败和副作用确定性，供后续安全续跑。",
        _object_schema(
            {
                "draftBatchId": _ID,
                "version": {"type": "integer", "minimum": 1},
                "childIndex": {"type": "integer", "minimum": 0, "maximum": 4},
                "generationRevision": {"type": "integer", "minimum": 1},
                "error": {"type": "object"},
            },
            ["draftBatchId", "version", "childIndex", "generationRevision", "error"],
        ),
        False,
        30,
    ),
    AgentToolDefinition(
        "chapter.draft.start",
        "幂等受理一个后台章节草稿 Operation，并立即返回 operationId。",
        _object_schema(
            {
                "operationKey": _ID,
                "generationRevision": {"type": "integer", "minimum": 1},
                "operationDeadlineAt": {"type": "string", "format": "date-time"},
                "maxAttempts": {"type": "integer", "minimum": 1, "maximum": 4},
                "owner": {"type": "object"},
                "payload": {"type": "object"},
            },
            ["operationKey", "generationRevision", "payload"],
        ),
        False,
        30,
        True,
    ),
    AgentToolDefinition(
        "chapter.draft.get_status",
        "读取后台章节草稿 Operation 的权威状态和结果引用。",
        _object_schema({"operationId": _ID}, ["operationId"]),
        True,
        30,
        True,
    ),
    AgentToolDefinition(
        "chapter.draft.cancel",
        "请求取消后台章节草稿 Operation。",
        _object_schema(
            {
                "operationId": _ID,
                "expectedVersion": {"type": "integer", "minimum": 1},
            },
            ["operationId"],
        ),
        False,
        30,
        True,
    ),
    AgentToolDefinition(
        "chapter.draft.retry",
        "对明确失败且仍在预算内的章节草稿 Operation 发起新 attempt。",
        _object_schema(
            {
                "operationId": _ID,
                "expectedVersion": {"type": "integer", "minimum": 1},
            },
            ["operationId"],
        ),
        False,
        30,
    ),
    AgentToolDefinition(
        "chapter.generate_draft",
        "根据当前章节和用户意图生成可审核章节草稿。",
        _object_schema(
            {
                "novelId": _ID,
                "chapterId": _ID,
                "currentContent": {"type": "string"},
                "userIntent": {"type": "string", "minLength": 1},
                "locale": {"type": "string"},
                "presentation": {"type": "string", "enum": ["silent", "toast", "modal"]},
                "contextChapterCount": {"type": "integer", "minimum": 1, "maximum": 20},
                "recentRawChapterCount": {"type": "integer", "minimum": 1, "maximum": 3},
                "preparedContext": {"type": "object"},
                "draftBatchId": _ID,
                "childIndex": {"type": "integer", "minimum": 0, "maximum": 4},
                "generationRevision": {"type": "integer", "minimum": 1},
                "batchContext": {"type": "object"},
            },
            ["novelId", "chapterId", "currentContent"],
        ),
        False,
        390,
    ),
    AgentToolDefinition(
        "chapter.revise_draft",
        "根据结构化审批意见生成新的可审核章节草稿版本。",
        _object_schema(
            {
                "sourceDraftSessionId": _ID,
                "sourceDraftVersion": {"type": "integer", "minimum": 1},
                "reviewRequestId": _ID,
                "comments": {"type": "array", "minItems": 1, "items": {"type": "object"}},
                "locale": {"type": "string"},
            },
            ["sourceDraftSessionId", "sourceDraftVersion", "reviewRequestId", "comments"],
        ),
        False,
        390,
    ),
    AgentToolDefinition(
        "creative_assets.revise_draft",
        "根据结构化审批意见生成新的完整创作素材审核包。",
        _object_schema(
            {
                "sourceDraftSessionId": _ID,
                "sourceDraftVersion": {"type": "integer", "minimum": 1},
                "reviewRequestId": _ID,
                "comments": {"type": "array", "minItems": 1, "items": {"type": "object"}},
                "locale": {"type": "string"},
            },
            ["sourceDraftSessionId", "sourceDraftVersion", "reviewRequestId", "comments"],
        ),
        False,
        390,
    ),
    AgentToolDefinition(
        "creative_assets.generate_draft",
        "根据现有项目资料生成可审核创作资产草稿。",
        _object_schema(
            {
                "novelId": _ID,
                "brief": {"type": "string", "minLength": 1},
                "locale": {"type": "string"},
                "includeExistingEntities": {"type": "boolean"},
                "filterCompletedPlotLines": {"type": "boolean"},
            },
            ["novelId", "brief"],
        ),
        False,
        240,
    ),
    AgentToolDefinition(
        "creative_assets.validate_draft",
        "校验创作资产草稿结构、同名项和明显设定冲突。",
        _object_schema(
            {
                "draftSessionId": _ID,
                "version": {"type": "integer", "minimum": 1},
            },
            ["draftSessionId"],
        ),
        False,
        60,
    ),
)

AGENT_TOOL_BY_NAME = {definition.name: definition for definition in AGENT_TOOL_MANIFEST}
AVAILABLE_AGENT_TOOLS = [definition.name for definition in AGENT_TOOL_MANIFEST]
READ_ONLY_AGENT_TOOLS = [definition.name for definition in AGENT_TOOL_MANIFEST if definition.read_only]
DRAFT_TOOLS = {
    "chapter_draft": "chapter.generate_draft",
    "chapter_draft_batch": "chapter.generate_draft",
    "creative_assets_draft": "creative_assets.generate_draft",
}
