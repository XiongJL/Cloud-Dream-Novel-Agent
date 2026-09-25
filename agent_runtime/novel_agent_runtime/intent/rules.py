from __future__ import annotations

import re

from .schemas import IntentPreflight, IntentRequest


_OPERATION_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("novel.bootstrap", ("新建小说", "创建一本小说", "从零开始写小说", "开一本新书", "novel bootstrap", "new novel")),
    ("novel.project_initialize", ("初始化小说项目", "根据蓝图创建素材", "生成项目初始化草稿", "initialize novel project")),
    ("agent_skill.style_extract", ("提炼文风", "抽取文风", "文风 skill", "语言风格 skill", "风格技能包", "style extraction", "writing style skill")),
    ("novel.scope_audit", ("团队综合审计", "多专家审核", "项目全局审计", "团队检查", "团队审计", "综合检查", "scope audit")),
    ("writer.range_revision_plan", ("作者多章节修订计划", "多章节修订建议", "跨章修订计划", "改写顺序", "续写准备度", "writer revision plan")),
    ("editor.range_review", ("多章节编辑审核", "跨章编辑审核", "章节范围审核", "当前卷编辑审核", "整本编辑审核", "editor range review")),
    ("reader.journey_review", ("多章节读者盲测", "读者旅程", "跨章读者反馈", "顺序盲读", "当前卷读者反馈", "reader journey")),
    ("worldbuilding.range_consistency", ("多章节世界观审核", "世界观一致性", "设定一致性", "设定漂移", "规则冲突", "worldbuilding consistency")),
    ("research.range_fact_check", ("多章节事实核查", "多章节考据", "范围考据", "跨章考据", "当前卷考据", "整本考据", "research range fact check")),
    ("chapter.consistency_review", ("一致性", "前后矛盾", "设定冲突", "状态冲突", "时间线冲突", "审校", "校验这篇", "校验本章", "检查这篇", "review this chapter", "continuity", "consistency")),
    ("plotline.analysis", ("情节线分析", "主线支线", "主线和支线", "伏笔回收", "未回收伏笔", "长期停滞", "剧情线体检", "plotline analysis")),
    ("chapter.context", ("章节上下文", "装配上下文", "上下文包", "assemble chapter context")),
    ("chapter.scope_context", ("多章节上下文", "章节范围", "范围上下文", "cross chapter context")),
    ("chapter.create", ("新增一章", "新建一章", "创建一章", "写下一章", "新增章节", "新建章节", "create next chapter")),
    ("chapter.sequence_continuation", ("续写多章", "连续写两章", "连续写三章", "续写两章", "续写三章", "写后续几章", "continue multiple chapters")),
    ("chapter.batch_rewrite", ("批量改写章节", "批量改写", "改写多章", "重写多章", "重写选中章节", "batch rewrite")),
    ("chapter.continuation", ("续写", "继续写", "接着写", "往下写", "创作完整正文", "生成完整正文", "chapter.continuation", "continue the chapter", "continue writing")),
    ("chapter.rewrite", ("改写", "重写", "润色", "rewrite", "polish")),
    ("reader.feedback", ("读者反馈", "读者视角", "弃读", "追更", "reader feedback")),
    ("research.fact_check", ("考据", "事实核查", "资料来源", "fact check", "research", "rag.ask")),
)

_DRAFT_OPERATION_IDS = {
    "chapter.create",
    "chapter.sequence_continuation",
    "chapter.batch_rewrite",
    "chapter.continuation",
    "chapter.rewrite",
}
_CREATIVE_ACTIONS = ("新增", "添加", "补充", "生成", "创建", "扩展", "起草", "add", "create", "generate", "extend", "draft")
_CREATIVE_TARGETS = ("大纲", "剧情线", "故事线", "支线", "角色", "人物", "设定", "世界观", "地图", "物品", "素材", "outline", "plot", "character", "worldbuilding", "setting")
_EXPLICIT_CREATIVE_ASSET_REQUEST = re.compile(
    r"(?:新增|添加|创建|扩展|起草|生成|补充|add|create|generate|extend|draft)"
    r"[^，。；;,.!?！？]{0,10}"
    r"(?:大纲|剧情线|故事线|支线|角色卡|人物卡|人物设定|世界设定|世界观设定|地图|物品|素材|"
    r"outline|plotline|character card|worldbuilding asset|setting entry)",
    re.IGNORECASE,
)
_LOOKUP_MARKERS = ("当前", "现有", "已有", "项目里", "这本书", "多少", "有哪些", "列表", "现在的", "current", "existing", "list")
_PROJECT_OBJECTS = ("小说", "卷", "章节", "大纲", "剧情线", "角色", "人物", "设定", "世界观", "物品", "地图", "novel", "volume", "chapter", "outline", "character")
_NEGATION_PREFIX = re.compile(
    r"(?:不要|不用|不必|不需要|无需|别|先不|暂不|暂时不|禁止|避免|"
    r"do not|don't|dont|no need to|without)"
    r"[^，。；;,.!?！？]{0,12}$",
)
_NON_REQUESTED_DRAFT_PHRASES: tuple[re.Pattern[str], ...] = (
    re.compile(r"续写准备度"),
    re.compile(r"(?:生成|创建|输出|形成|整理|列出)[^，。；;,.!?！？]{0,14}(?:报告|清单|列表|建议|意见|分析|审核结果)"),
    re.compile(r"(?:续写|改写|重写|润色|补充|生成)(?:方向|建议|意见|必要性|可能性|需求|准备度)"),
    re.compile(r"(?:是否|需不需要|需要不需要|要不要|该不该|应不应该)[^，。；;,.!?！？]{0,8}(?:续写|改写|重写|润色|补充|生成)"),
    re.compile(r"(?:需要|需|待|建议|值得)(?:补充|改写|重写|润色|续写)(?:说明|解释|交代|的信息|的内容|之处|项|点)?"),
    re.compile(r"(?:讨论|聊聊|聊一聊|分析|评估|判断|看看)[^，。；;,.!?！？]{0,10}(?:怎么|如何|是否|要不要)?(?:续写|改写|重写|润色|补充|生成)"),
    re.compile(r"(?:想知道|想了解|请解释|告诉我)[^，。；;,.!?！？]{0,12}(?:怎么|如何)?(?:续写|改写|重写|润色|补充|生成)"),
    re.compile(r"(?:续写|改写|重写|润色|补充|生成)[^，。；;,.!?！？]{0,10}(?:有什么区别|是什么意思|会不会|是否会|会否|是否合适|是否可行)"),
    re.compile(r"(?:检查|检测|审核|审校|分析|评估|判断|讨论|查看|列出)(?:(?!然后|接着|再|后)[^，。；;,.!?！？]){0,12}(?:新增|添加|补充|创建|生成|扩展|起草)"),
    re.compile(r"为(?:后续|之后|下一步)?[^，。；;,.!?！？]{0,6}续写[^，。；;,.!?！？]{0,6}(?:准备|铺垫)"),
    re.compile(r"(?:continuation|rewrite|polish|generation)\s+(?:advice|suggestion|direction|readiness)"),
    re.compile(r"(?:generate|create|produce|build)[^,.;!?]{0,24}(?:report|checklist|list|analysis|advice)"),
    re.compile(r"(?:discuss|consider|assess|evaluate)[^,.;!?]{0,24}(?:continue|rewrite|polish|generate)"),
)
_CONVERSATION_FIRST_MARKERS = (
    "先讨论", "只讨论", "仅讨论", "先聊", "聊聊", "聊一聊",
    "不要执行", "无需执行", "先不执行", "不要生成", "先不生成",
    "先别改", "不要改", "只给建议", "仅给建议",
    "想知道", "想了解", "有什么区别",
    "discuss first", "just discuss", "do not execute", "don't execute",
    "do not generate", "don't generate", "advice only",
)

_CHAPTER_COUNT_TOKENS: dict[str, int] = {
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "几": 2,
    "多": 2,
}
_ORDINAL_CHAPTER_REFERENCE = re.compile(
    r"(?:最后一章|最终一章|倒数第?[一二两三四五1-5]章|第\s*[一二两三四五1-5]\s*章|末章|最终章)"
)
_EXPLICIT_CHAPTER_RANGE = re.compile(
    r"第?\s*[零〇一二两三四五六七八九十百\d]+\s*(?:章)?\s*(?:到|至|—|－|-|~|～)\s*"
    r"第?\s*[零〇一二两三四五六七八九十百\d]+\s*章"
)


def _mask_span(value: str, start: int, end: int) -> str:
    return value[:start] + (" " * (end - start)) + value[end:]


def _is_negated(value: str, start: int) -> bool:
    prefix = value[max(0, start - 32):start]
    return _NEGATION_PREFIX.search(prefix) is not None


def _mask_non_requested_draft_language(message: str) -> str:
    masked = message
    for pattern in _NON_REQUESTED_DRAFT_PHRASES:
        for match in reversed(list(pattern.finditer(masked))):
            masked = _mask_span(masked, match.start(), match.end())
    draft_markers = {
        marker
        for operation_id, patterns in _OPERATION_PATTERNS
        if operation_id in _DRAFT_OPERATION_IDS
        for marker in patterns
    } | set(_CREATIVE_ACTIONS)
    for marker in sorted(draft_markers, key=len, reverse=True):
        start = 0
        while (position := masked.find(marker, start)) >= 0:
            end = position + len(marker)
            if _is_negated(masked, position):
                masked = _mask_span(masked, position, end)
            start = end
    return masked


def prefers_conversation(message: str, explicit_operations: list[str] | None = None) -> bool:
    normalized = message.strip().lower()
    if not any(marker in normalized for marker in _CONVERSATION_FIRST_MARKERS):
        return False
    operations = explicit_operations if explicit_operations is not None else detect_explicit_operations(message)
    return not any(
        (definition := _operation_effect(operation_id)) == "draft_write"
        for operation_id in operations
    )


def _operation_effect(operation_id: str) -> str | None:
    # Keep rules independent from the registry to avoid an import cycle.
    if operation_id in _DRAFT_OPERATION_IDS or operation_id == "creative_asset.draft":
        return "draft_write"
    return "read_only" if operation_id else None


def marker_is_requested(message: str, marker: str) -> bool:
    normalized = message.strip().lower()
    start = 0
    while (position := normalized.find(marker, start)) >= 0:
        if not _is_negated(normalized, position):
            return True
        start = position + len(marker)
    return False


def explicitly_requests_creative_assets(message: str) -> bool:
    """Require an asset creation verb to govern an asset noun locally.

    Chapter briefs often mention characters or world rules as constraints. Those
    nouns alone must not schedule a separate creative-assets deliverable.
    """
    normalized = _mask_non_requested_draft_language(message.strip().lower())
    return any(not _is_negated(normalized, match.start()) for match in _EXPLICIT_CREATIVE_ASSET_REQUEST.finditer(normalized))


def requests_post_generation_review(message: str) -> bool:
    normalized = message.strip().lower()
    generation_markers = (
        "续写", "继续写", "接着写", "完整章节", "完整一章", "完整正文", "完成正文", "生成正文", "写完",
        "chapter.continuation",
        "continue", "write the chapter", "complete the chapter", "generate the chapter",
    )
    review_markers = (
        "编辑检查", "编辑审核", "编辑审校", "审校", "校对", "检查逻辑", "检查视角",
        "editor review", "edit and review", "proofread", "continuity review",
    )
    generation_positions = [normalized.find(marker) for marker in generation_markers if marker in normalized]
    review_positions = [normalized.find(marker) for marker in review_markers if marker in normalized]
    return bool(generation_positions and review_positions and min(generation_positions) < min(review_positions))


def build_preflight(request: IntentRequest) -> IntentPreflight:
    reasons: list[str] = []
    if request.source != "chat":
        reasons.append("STRUCTURED_ENTRY")
    force_chat_only = request.approvalMode == "chat_only"
    if force_chat_only:
        reasons.append("CHAT_ONLY_MODE")
    pending = request.conversationState.pendingClarification
    if pending:
        reasons.append("PENDING_CLARIFICATION")
    pending_approval = request.conversationState.hasPendingApproval and request.source == "chat"
    if pending_approval:
        reasons.append("PENDING_APPROVAL")
    if any((request.currentSelection.novelId, request.currentSelection.volumeId, request.currentSelection.chapterId, request.currentSelection.selectedText)):
        reasons.append("CURRENT_SELECTION")
    return IntentPreflight(
        source=request.source,
        forceChatOnly=force_chat_only,
        pendingClarification=pending,
        pendingApprovalNotice=pending_approval,
        reasonCodes=reasons,
    )


def requested_continuation_chapter_count(message: str) -> int | None:
    """Extract a requested generation count without treating target ordinals as counts."""
    normalized = _mask_non_requested_draft_language(message.strip().lower())
    count_source = _ORDINAL_CHAPTER_REFERENCE.sub(" ", normalized)
    match = re.search(
        r"(?:续写|继续写|接着写|连续写|往下写|再写|生成)(?:(?!第).){0,10}([1-5一二两三四五几多])\s*(?:个)?章",
        count_source,
    )
    if not match:
        return None
    token = match.group(1)
    return _CHAPTER_COUNT_TOKENS.get(token, int(token) if token.isdigit() else None)


def requested_created_chapter_count(message: str) -> int | None:
    """Extract the number of newly inserted chapters; omitted means one."""
    normalized = message.strip().lower()
    match = re.search(
        r"(?:新增|新建|创建|写下)(?:.{0,6}?)([1-5一二两三四五])\s*(?:个)?章",
        normalized,
    )
    if not match:
        return 1 if any(marker in normalized for marker in ("新增章节", "新建章节", "创建章节", "写下一章")) else None
    token = match.group(1)
    return _CHAPTER_COUNT_TOKENS.get(token, int(token) if token.isdigit() else None)


def detect_explicit_operations(message: str) -> list[str]:
    normalized = message.strip().lower()
    actionable_draft_text = _mask_non_requested_draft_language(normalized)
    matches: list[tuple[int, str]] = []
    requested_count = requested_continuation_chapter_count(actionable_draft_text)
    if _EXPLICIT_CHAPTER_RANGE.search(actionable_draft_text) and any(
        marker in actionable_draft_text for marker in ("改写", "重写", "润色", "rewrite")
    ):
        rewrite_positions = [
            actionable_draft_text.find(marker)
            for marker in ("改写", "重写", "润色", "rewrite")
            if marker in actionable_draft_text
        ]
        matches.append((min(rewrite_positions) if rewrite_positions else 0, "chapter.batch_rewrite"))
    create_count = requested_created_chapter_count(actionable_draft_text)
    if create_count is not None:
        create_positions = [
            actionable_draft_text.find(marker)
            for marker in ("新增", "新建", "创建", "写下一", "create")
            if marker in actionable_draft_text
        ]
        matches.append((min(create_positions) if create_positions else 0, "chapter.create"))
    if requested_count is not None:
        action_positions = [
            actionable_draft_text.find(marker)
            for marker in ("续写", "继续写", "接着写", "连续写", "往下写", "再写", "生成")
            if marker in actionable_draft_text
        ]
        matches.append((min(action_positions) if action_positions else 0, "chapter.sequence_continuation"))
    for operation_id, patterns in _OPERATION_PATTERNS:
        source = actionable_draft_text if operation_id in _DRAFT_OPERATION_IDS else normalized
        positions = [source.find(pattern) for pattern in patterns if pattern in source]
        if positions:
            matches.append((min(positions), operation_id))
    action_positions = [actionable_draft_text.find(marker) for marker in _CREATIVE_ACTIONS if marker in actionable_draft_text]
    target_positions = [actionable_draft_text.find(marker) for marker in _CREATIVE_TARGETS if marker in actionable_draft_text]
    if action_positions and target_positions:
        matches.append((min(*action_positions, *target_positions), "creative_asset.draft"))
    if not matches and any(marker in normalized for marker in _LOOKUP_MARKERS) and any(marker in normalized for marker in _PROJECT_OBJECTS):
        matches.append((0, "project.lookup"))
    if any(operation_id == "chapter.scope_context" for _, operation_id in matches):
        matches = [item for item in matches if item[1] != "chapter.context"]
    if any(operation_id == "editor.range_review" for _, operation_id in matches):
        matches = [
            item for item in matches
            if item[1] not in {"chapter.consistency_review", "chapter.scope_context", "chapter.context"}
        ]
    if any(operation_id == "writer.range_revision_plan" for _, operation_id in matches):
        matches = [
            item for item in matches
            if item[1] not in {"chapter.scope_context", "chapter.context", "chapter.rewrite"}
        ]
    if any(operation_id == "reader.journey_review" for _, operation_id in matches):
        matches = [
            item for item in matches
            if item[1] not in {"reader.feedback", "chapter.scope_context", "chapter.context"}
        ]
    if any(operation_id == "worldbuilding.range_consistency" for _, operation_id in matches):
        matches = [
            item for item in matches
            if item[1] not in {"chapter.consistency_review", "chapter.scope_context", "chapter.context"}
        ]
    if any(operation_id == "research.range_fact_check" for _, operation_id in matches):
        matches = [
            item for item in matches
            if item[1] not in {"research.fact_check", "chapter.scope_context", "chapter.context"}
        ]
    if any(operation_id == "novel.scope_audit" for _, operation_id in matches):
        matches = [
            item for item in matches
            if item[1] not in {
                "editor.range_review",
                "writer.range_revision_plan",
                "reader.journey_review",
                "worldbuilding.range_consistency",
                "research.range_fact_check",
                "research.fact_check",
                "chapter.consistency_review",
                "chapter.scope_context",
                "chapter.context",
            }
        ]
    if any(operation_id == "chapter.sequence_continuation" for _, operation_id in matches):
        matches = [item for item in matches if item[1] != "chapter.continuation"]
    if any(operation_id == "chapter.batch_rewrite" for _, operation_id in matches):
        matches = [item for item in matches if item[1] not in {"chapter.rewrite", "chapter.scope_context", "chapter.context"}]
    if any(operation_id in _DRAFT_OPERATION_IDS for _, operation_id in matches):
        if not explicitly_requests_creative_assets(message):
            matches = [item for item in matches if item[1] != "creative_asset.draft"]
    ordered: list[str] = []
    for _, operation_id in sorted(matches, key=lambda item: item[0]):
        if operation_id not in ordered:
            ordered.append(operation_id)
    return ordered


def is_light_conversation(message: str) -> bool:
    normalized = re.sub(r"[\s,.!?，。！？]+", "", message.strip().lower())
    return normalized in {
        "你好", "您好", "嗨", "在吗", "谢谢", "好的", "ok", "hello", "hi", "thanks",
        "你能做什么", "你有什么能力", "介绍一下你的能力", "whatcanyoudo",
    }
