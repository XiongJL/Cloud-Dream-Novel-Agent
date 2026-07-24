from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel, Field

from .schemas import IntentDeliverable, IntentEffect


class IntentOperationDefinition(BaseModel):
    id: str
    title: str
    defaultDeliverable: IntentDeliverable
    requestedEffect: IntentEffect
    targetKind: str
    contextNeeds: tuple[str, ...] = ()
    defaultRole: str | None = None
    intentHints: tuple[str, ...] = ()
    fallbackTools: tuple[str, ...] = ()

    def public_contract(self) -> dict[str, object]:
        return {
            "id": self.id,
            "title": self.title,
            "defaultDeliverable": self.defaultDeliverable,
            "requestedEffect": self.requestedEffect,
            "targetKind": self.targetKind,
            "contextNeeds": list(self.contextNeeds),
            "defaultRole": self.defaultRole,
            "intentHints": list(self.intentHints),
        }


class IntentOperationRegistry:
    def __init__(self, definitions: Iterable[IntentOperationDefinition]) -> None:
        self._definitions: dict[str, IntentOperationDefinition] = {}
        for definition in definitions:
            if definition.id in self._definitions:
                raise ValueError(f"Duplicate Intent Operation registration: {definition.id}")
            self._definitions[definition.id] = definition

    def get(self, operation_id: str) -> IntentOperationDefinition | None:
        return self._definitions.get(operation_id)

    def require(self, operation_id: str) -> IntentOperationDefinition:
        definition = self.get(operation_id)
        if not definition:
            raise ValueError(f"Unknown Intent Operation: {operation_id}")
        return definition

    def has(self, operation_id: str) -> bool:
        return operation_id in self._definitions

    def list_public(self) -> list[dict[str, object]]:
        return [definition.public_contract() for definition in self._definitions.values()]


INTENT_OPERATION_REGISTRY = IntentOperationRegistry(
    [
        IntentOperationDefinition(
            id="project.lookup",
            title="查询项目事实",
            defaultDeliverable="none",
            requestedEffect="read_only",
            targetKind="novel",
            contextNeeds=("project_facts",),
            intentHints=("当前项目", "现有内容", "有哪些", "多少"),
        ),
        IntentOperationDefinition(
            id="chapter.context",
            title="装配章节上下文",
            defaultDeliverable="report",
            requestedEffect="read_only",
            targetKind="chapter",
            contextNeeds=("current_chapter", "adjacent_chapters", "plotlines", "characters", "worldsettings"),
            defaultRole="editor",
            intentHints=("章节上下文", "装配上下文"),
        ),
        IntentOperationDefinition(
            id="chapter.scope_context",
            title="装配多章节范围上下文",
            defaultDeliverable="report",
            requestedEffect="read_only",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries", "narrative_summaries", "project_entities", "research_evidence"),
            defaultRole="editor",
            intentHints=("多章节上下文", "章节范围", "范围上下文", "跨章上下文"),
        ),
        IntentOperationDefinition(
            id="chapter.consistency_review",
            title="审核章节一致性",
            defaultDeliverable="report",
            requestedEffect="read_only",
            targetKind="chapter",
            contextNeeds=("current_chapter", "plotlines", "characters", "worldsettings", "items"),
            defaultRole="editor",
            intentHints=("一致性", "前后矛盾", "设定冲突", "时间线冲突"),
        ),
        IntentOperationDefinition(
            id="writer.range_revision_plan",
            title="作者多章节修订计划",
            defaultDeliverable="expert_report",
            requestedEffect="read_only",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries", "project_entities", "plotlines", "research_evidence"),
            defaultRole="writer",
            intentHints=("作者多章节修订计划", "多章节修订建议", "改写顺序", "续写准备度", "writer revision plan"),
        ),
        IntentOperationDefinition(
            id="editor.range_review",
            title="编辑多章节范围审核",
            defaultDeliverable="expert_report",
            requestedEffect="read_only",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries", "project_entities", "plotlines", "research_evidence"),
            defaultRole="editor",
            intentHints=("多章节编辑审核", "跨章编辑审核", "章节范围审核", "当前卷编辑审核", "editor range review"),
        ),
        IntentOperationDefinition(
            id="chapter.continuation",
            title="续写章节",
            defaultDeliverable="chapter_draft",
            requestedEffect="draft_write",
            targetKind="chapter",
            contextNeeds=("current_chapter", "plotlines", "characters", "worldsettings"),
            defaultRole="writer",
            intentHints=("续写", "继续写", "接着写"),
            fallbackTools=("chapter.generate_draft",),
        ),
        IntentOperationDefinition(
            id="chapter.sequence_continuation",
            title="连续续写多章",
            defaultDeliverable="chapter_draft_batch",
            requestedEffect="draft_write",
            targetKind="chapter",
            contextNeeds=("current_chapter", "chapter_summaries", "plotlines", "characters", "worldsettings"),
            defaultRole="writer",
            intentHints=("续写多章", "连续写几章", "写后续章节", "continue multiple chapters"),
            fallbackTools=("chapter.generate_draft",),
        ),
        IntentOperationDefinition(
            id="chapter.batch_rewrite",
            title="批量改写多章",
            defaultDeliverable="chapter_draft_batch",
            requestedEffect="draft_write",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries", "plotlines", "characters", "worldsettings"),
            defaultRole="writer",
            intentHints=("批量改写章节", "改写多章", "重写选中章节", "batch rewrite"),
            fallbackTools=("chapter.generate_draft",),
        ),
        IntentOperationDefinition(
            id="chapter.rewrite",
            title="改写章节",
            defaultDeliverable="chapter_draft",
            requestedEffect="draft_write",
            targetKind="chapter",
            contextNeeds=("current_chapter", "selected_text"),
            defaultRole="writer",
            intentHints=("改写", "重写", "润色"),
            fallbackTools=("chapter.generate_draft",),
        ),
        IntentOperationDefinition(
            id="creative_asset.draft",
            title="生成创作素材草稿",
            defaultDeliverable="creative_assets_draft",
            requestedEffect="draft_write",
            targetKind="novel",
            contextNeeds=("project_structure", "plotlines", "characters", "worldsettings"),
            defaultRole="worldbuilding",
            intentHints=("新增大纲", "新增角色", "补充设定", "世界观"),
            fallbackTools=("creative_assets.generate_draft",),
        ),
        IntentOperationDefinition(
            id="plotline.analysis",
            title="分析主线、支线与伏笔",
            defaultDeliverable="report",
            requestedEffect="read_only",
            targetKind="novel",
            contextNeeds=("project_structure", "plotlines", "chapter_batches", "research_evidence"),
            defaultRole="editor",
            intentHints=("情节线分析", "主线支线", "伏笔回收", "长期停滞", "剧情线体检"),
            fallbackTools=("plotline.list", "volume.list", "chapter.list", "rag.ask"),
        ),
        IntentOperationDefinition(
            id="reader.feedback",
            title="生成读者反馈",
            defaultDeliverable="report",
            requestedEffect="read_only",
            targetKind="chapter",
            contextNeeds=("current_chapter", "adjacent_chapters"),
            defaultRole="reader",
            intentHints=("读者反馈", "弃读点", "追更动力"),
        ),
        IntentOperationDefinition(
            id="reader.journey_review",
            title="读者多章节顺序盲测",
            defaultDeliverable="expert_report",
            requestedEffect="read_only",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries"),
            defaultRole="reader",
            intentHints=("多章节读者盲测", "读者旅程", "跨章读者反馈", "顺序盲读", "reader journey"),
        ),
        IntentOperationDefinition(
            id="worldbuilding.range_consistency",
            title="世界观多章节一致性审核",
            defaultDeliverable="expert_report",
            requestedEffect="read_only",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries", "project_entities", "plotlines", "research_evidence"),
            defaultRole="worldbuilding",
            intentHints=("多章节世界观审核", "世界观一致性", "设定一致性", "设定漂移", "规则冲突", "worldbuilding consistency"),
        ),
        IntentOperationDefinition(
            id="research.fact_check",
            title="考据与事实核查",
            defaultDeliverable="report",
            requestedEffect="read_only",
            targetKind="novel",
            contextNeeds=("project_facts", "research_evidence"),
            defaultRole="research_rag",
            intentHints=("考据", "事实核查", "资料来源"),
            fallbackTools=("rag.ask", "search.query"),
        ),
        IntentOperationDefinition(
            id="research.range_fact_check",
            title="多章节考据与事实核查",
            defaultDeliverable="expert_report",
            requestedEffect="read_only",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries", "project_facts", "research_evidence"),
            defaultRole="research_rag",
            intentHints=("多章节事实核查", "范围考据", "跨章考据", "当前卷考据", "research range fact check"),
        ),
        IntentOperationDefinition(
            id="novel.scope_audit",
            title="团队多章节综合审计",
            defaultDeliverable="expert_report",
            requestedEffect="read_only",
            targetKind="chapter_scope",
            contextNeeds=("chapter_scope", "chapter_summaries", "project_entities", "plotlines", "research_evidence"),
            defaultRole="team",
            intentHints=("团队综合审计", "多专家审核", "项目全局审计", "团队检查", "scope audit"),
        ),
    ]
)
