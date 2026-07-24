from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..roles import ALLOWED_ROLES
from ..tool_manifest import AGENT_TOOL_BY_NAME
from ..intent.operations import INTENT_OPERATION_REGISTRY
from .schemas import (
    ChapterConsistencyReviewInput,
    ChapterBatchRewriteInput,
    ChapterContinuationInput,
    ChapterDraftBatchResult,
    ChapterSequenceContinuationInput,
    ChapterContextInput,
    ChapterScopeBundle,
    ChapterScopeContextInput,
    ContextBundle,
    CreativeAssetDraftInput,
    DraftToolchainResult,
    EditorRangeReviewArtifact,
    EditorRangeReviewInput,
    PlotlineAnalysisArtifact,
    PlotlineAnalysisInput,
    ReaderJourneyArtifact,
    ReaderJourneyReviewInput,
    ResearchFactCheckArtifact,
    ResearchRangeFactCheckInput,
    ScopeAuditArtifact,
    ScopeAuditInput,
    WorldbuildingConsistencyArtifact,
    WorldbuildingRangeConsistencyInput,
    WriterRangeRevisionPlanArtifact,
    WriterRangeRevisionPlanInput,
    ReviewArtifact,
    ToolchainBudget,
    ToolchainError,
)


class ToolchainDefinition(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    id: str
    version: str
    title: str
    description: str
    inputModel: type[BaseModel]
    outputModel: type[BaseModel]
    allowedRoles: tuple[str, ...]
    requiredTools: tuple[str, ...]
    sideEffect: Literal["read_only", "draft_write"]
    supportedOperations: tuple[str, ...]
    intentHints: tuple[str, ...] = ()
    enabled: bool = True
    budget: ToolchainBudget = Field(default_factory=ToolchainBudget)

    def public_contract(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "allowedRoles": list(self.allowedRoles),
            "requiredTools": list(self.requiredTools),
            "sideEffect": self.sideEffect,
            "supportedOperations": list(self.supportedOperations),
            "intentHints": list(self.intentHints),
            "enabled": self.enabled,
            "budget": self.budget.model_dump(),
            "inputSchema": self.inputModel.model_json_schema(),
            "outputSchema": self.outputModel.model_json_schema(),
        }


class ToolchainRegistry:
    def __init__(self, definitions: Iterable[ToolchainDefinition]) -> None:
        self._definitions: dict[tuple[str, str], ToolchainDefinition] = {}
        for definition in definitions:
            self._validate(definition)
            key = (definition.id, definition.version)
            if key in self._definitions:
                raise ValueError(f"Duplicate Toolchain registration: {definition.id}@{definition.version}")
            self._definitions[key] = definition

    def _validate(self, definition: ToolchainDefinition) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+", definition.id):
            raise ValueError(f"Invalid Toolchain id: {definition.id}")
        if not re.fullmatch(r"\d+\.\d+\.\d+", definition.version):
            raise ValueError(f"Invalid Toolchain version: {definition.version}")
        unknown_roles = set(definition.allowedRoles) - set(ALLOWED_ROLES)
        if unknown_roles:
            raise ValueError(f"Unknown Toolchain roles: {', '.join(sorted(unknown_roles))}")
        unknown_tools = set(definition.requiredTools) - set(AGENT_TOOL_BY_NAME)
        if unknown_tools:
            raise ValueError(f"Unknown Toolchain tools: {', '.join(sorted(unknown_tools))}")
        if definition.sideEffect == "read_only":
            writable = [name for name in definition.requiredTools if not AGENT_TOOL_BY_NAME[name].read_only]
            if writable:
                raise ValueError(f"Read-only Toolchain contains writable tools: {', '.join(writable)}")
        unknown_operations = [item for item in definition.supportedOperations if not INTENT_OPERATION_REGISTRY.has(item)]
        if unknown_operations:
            raise ValueError(f"Unknown Toolchain operations: {', '.join(unknown_operations)}")

    def resolve(self, toolchain_id: str, version: str, role: str | None = None) -> ToolchainDefinition:
        versions = [item for (item_id, _), item in self._definitions.items() if item_id == toolchain_id]
        if not versions:
            raise ToolchainError("TOOLCHAIN_NOT_FOUND", f"Toolchain not found: {toolchain_id}")
        definition = self._definitions.get((toolchain_id, version))
        if not definition:
            raise ToolchainError("VERSION_UNAVAILABLE", f"Toolchain version unavailable: {toolchain_id}@{version}")
        if not definition.enabled:
            raise ToolchainError("TOOLCHAIN_DISABLED", f"Toolchain is disabled: {toolchain_id}@{version}")
        if role and role not in definition.allowedRoles:
            raise ToolchainError("ROLE_NOT_ALLOWED", f"Role {role} cannot invoke {toolchain_id}")
        return definition

    def list_public(self) -> list[dict[str, Any]]:
        return [definition.public_contract() for definition in self._definitions.values() if definition.enabled]

    def find_for_operation(self, operation_id: str, *, include_disabled: bool = False) -> list[ToolchainDefinition]:
        return [
            definition
            for definition in self._definitions.values()
            if operation_id in definition.supportedOperations and (include_disabled or definition.enabled)
        ]


TOOLCHAIN_REGISTRY = ToolchainRegistry(
    [
        ToolchainDefinition(
            id="chapter.context",
            version="1.0.0",
            title="章节上下文装配",
            description="读取当前章节、相邻结构和相关项目资料，形成可预算的结构化上下文。",
            inputModel=ChapterContextInput,
            outputModel=ContextBundle,
            allowedRoles=("team", "writer", "editor", "reader", "worldbuilding", "research_rag"),
            requiredTools=(
                "chapter.get",
                "volume.list",
                "chapter.list",
                "plotline.list",
                "character.list",
                "worldsetting.list",
                "item.list",
                "rag.ask",
            ),
            sideEffect="read_only",
            supportedOperations=("chapter.context",),
            intentHints=("章节上下文", "装配上下文", "chapter context"),
            budget=ToolchainBudget(maxToolCalls=10, maxEstimatedTokens=24000, timeoutSeconds=180),
        ),
        ToolchainDefinition(
            id="chapter.scope_context",
            version="1.0.0",
            title="多章节范围上下文",
            description="按已批准范围一次装配章节、摘要、项目实体、情节线、版本快照和覆盖统计。",
            inputModel=ChapterScopeContextInput,
            outputModel=ChapterScopeBundle,
            allowedRoles=("team", "writer", "editor", "reader", "worldbuilding", "research_rag"),
            requiredTools=("chapter.scope_context.build", "rag.ask"),
            sideEffect="read_only",
            supportedOperations=("chapter.scope_context",),
            intentHints=("多章节上下文", "章节范围", "范围上下文", "cross chapter context"),
            budget=ToolchainBudget(maxToolCalls=2, maxEstimatedTokens=80000, timeoutSeconds=240),
        ),
        ToolchainDefinition(
            id="chapter.consistency_review",
            version="1.0.0",
            title="章节一致性审核",
            description="基于章节上下文检查人物、情节时间线、世界规则和物品技能一致性。",
            inputModel=ChapterConsistencyReviewInput,
            outputModel=ReviewArtifact,
            allowedRoles=("team", "editor", "reader", "worldbuilding"),
            requiredTools=(
                "chapter.get",
                "volume.list",
                "chapter.list",
                "plotline.list",
                "character.list",
                "worldsetting.list",
                "item.list",
                "rag.ask",
            ),
            sideEffect="read_only",
            supportedOperations=("chapter.consistency_review",),
            intentHints=("一致性", "前后矛盾", "设定冲突", "consistency review"),
            budget=ToolchainBudget(maxToolCalls=10, maxEstimatedTokens=28000, timeoutSeconds=240),
        ),
        ToolchainDefinition(
            id="writer.range_revision_plan",
            version="1.0.0",
            title="作者多章节修订计划",
            description="共享装配已批准章节范围，评估文风漂移、场景强弱、改写优先级和续写准备度，生成可逐条审批的作者报告。",
            inputModel=WriterRangeRevisionPlanInput,
            outputModel=WriterRangeRevisionPlanArtifact,
            allowedRoles=("team", "writer"),
            requiredTools=("chapter.scope_context.build", "rag.ask"),
            sideEffect="read_only",
            supportedOperations=("writer.range_revision_plan",),
            intentHints=("作者多章节修订计划", "多章节修订建议", "改写顺序", "续写准备度", "writer revision plan"),
            budget=ToolchainBudget(maxToolCalls=2, maxModelCalls=1, maxEstimatedTokens=80000, timeoutSeconds=360),
        ),
        ToolchainDefinition(
            id="editor.range_review",
            version="1.0.0",
            title="编辑多章节范围审核",
            description="共享装配已批准章节范围，从结构、节奏、动机、文字质量和跨章连续性生成可逐条审批的编辑报告。",
            inputModel=EditorRangeReviewInput,
            outputModel=EditorRangeReviewArtifact,
            allowedRoles=("team", "editor"),
            requiredTools=("chapter.scope_context.build", "rag.ask"),
            sideEffect="read_only",
            supportedOperations=("editor.range_review",),
            intentHints=("多章节编辑审核", "跨章编辑审核", "章节范围审核", "editor range review"),
            budget=ToolchainBudget(maxToolCalls=2, maxModelCalls=1, maxEstimatedTokens=80000, timeoutSeconds=360),
        ),
        ToolchainDefinition(
            id="reader.journey_review",
            version="1.0.0",
            title="读者多章节顺序盲测",
            description="按作品顺序逐章评估读者困惑、情绪、悬念、弃读风险与追更动力，严格隔离未来章节和后台设定。",
            inputModel=ReaderJourneyReviewInput,
            outputModel=ReaderJourneyArtifact,
            allowedRoles=("team", "reader"),
            requiredTools=("chapter.scope_context.build",),
            sideEffect="read_only",
            supportedOperations=("reader.journey_review",),
            intentHints=("多章节读者盲测", "读者旅程", "跨章读者反馈", "顺序盲读", "reader journey"),
            budget=ToolchainBudget(maxToolCalls=1, maxModelCalls=20, maxEstimatedTokens=80000, timeoutSeconds=900),
        ),
        ToolchainDefinition(
            id="worldbuilding.range_consistency",
            version="1.0.0",
            title="世界观多章节一致性审核",
            description="核对已批准章节范围内的规则、术语、能力、地点、物品和跨章状态漂移，生成可逐条审批的世界观专家报告。",
            inputModel=WorldbuildingRangeConsistencyInput,
            outputModel=WorldbuildingConsistencyArtifact,
            allowedRoles=("team", "worldbuilding"),
            requiredTools=("chapter.scope_context.build", "rag.ask"),
            sideEffect="read_only",
            supportedOperations=("worldbuilding.range_consistency",),
            intentHints=("多章节世界观审核", "世界观一致性", "设定漂移", "规则冲突", "worldbuilding consistency"),
            budget=ToolchainBudget(maxToolCalls=2, maxModelCalls=1, maxEstimatedTokens=80000, timeoutSeconds=360),
        ),
        ToolchainDefinition(
            id="research.range_fact_check",
            version="1.0.0",
            title="多章节考据与事实核查",
            description="从批准章节范围提取可核验声明，关联 RAG 与项目全文检索证据，输出来源、可信度和未核验项。",
            inputModel=ResearchRangeFactCheckInput,
            outputModel=ResearchFactCheckArtifact,
            allowedRoles=("team", "research_rag"),
            requiredTools=("chapter.scope_context.build", "rag.ask", "search.query"),
            sideEffect="read_only",
            supportedOperations=("research.range_fact_check",),
            intentHints=("多章节事实核查", "范围考据", "跨章考据", "当前卷考据", "research range fact check"),
            budget=ToolchainBudget(maxToolCalls=7, maxModelCalls=2, maxEstimatedTokens=80000, timeoutSeconds=720),
        ),
        ToolchainDefinition(
            id="novel.scope_audit",
            version="1.0.0",
            title="团队多章节综合审计",
            description="共享一次章节范围读取，执行已批准的编辑、读者、世界观与考据专家，并对真实子报告去重、标记共识和分歧。",
            inputModel=ScopeAuditInput,
            outputModel=ScopeAuditArtifact,
            allowedRoles=("team",),
            requiredTools=("chapter.scope_context.build", "rag.ask", "search.query"),
            sideEffect="read_only",
            supportedOperations=("novel.scope_audit",),
            intentHints=("团队综合审计", "多专家审核", "项目全局审计", "综合检查", "scope audit"),
            budget=ToolchainBudget(maxToolCalls=7, maxModelCalls=25, maxEstimatedTokens=80000, timeoutSeconds=1200),
        ),
        ToolchainDefinition(
            id="chapter.continuation",
            version="1.0.0",
            title="章节续写草稿",
            description="装配章节上下文、确认高影响方向，并生成可审核的章节 DraftSession。",
            inputModel=ChapterContinuationInput,
            outputModel=DraftToolchainResult,
            allowedRoles=("team", "writer", "editor"),
            requiredTools=(
                "chapter.continuation_context.build",
                "rag.ask",
                "chapter.generate_draft",
            ),
            sideEffect="draft_write",
            supportedOperations=("chapter.continuation",),
            intentHints=("续写", "继续写", "接着写", "chapter continuation"),
            budget=ToolchainBudget(maxToolCalls=3, maxModelCalls=1, maxEstimatedTokens=60000, timeoutSeconds=300),
        ),
        ToolchainDefinition(
            id="chapter.sequence_continuation",
            version="1.0.0",
            title="连续多章续写草稿",
            description="装配一次基础上下文，审批整批章节节拍，按顺序生成 1 至 5 个父子草稿并提取正文状态增量。",
            inputModel=ChapterSequenceContinuationInput,
            outputModel=ChapterDraftBatchResult,
            allowedRoles=("team", "writer", "editor"),
            requiredTools=(
                "chapter.continuation_context.build",
                "agent.generate_chapter_beats",
                "draft.batch.create",
                "draft.batch.approve_outline",
                "draft.batch.get",
                "draft.batch.prepare_regeneration",
                "draft.batch.mark_failed",
                "chapter.generate_draft",
            ),
            sideEffect="draft_write",
            supportedOperations=("chapter.sequence_continuation",),
            intentHints=("续写多章", "连续写几章", "后续章节", "multiple chapter continuation"),
            budget=ToolchainBudget(maxToolCalls=12, maxModelCalls=11, maxEstimatedTokens=160000, timeoutSeconds=1200),
        ),
        ToolchainDefinition(
            id="chapter.batch_rewrite",
            version="1.0.0",
            title="多章节批量改写",
            description="读取明确选择的 1 至 5 章，审批整批修订节拍，按作品顺序生成完整替换草稿并固定来源版本快照。",
            inputModel=ChapterBatchRewriteInput,
            outputModel=ChapterDraftBatchResult,
            allowedRoles=("team", "writer", "editor"),
            requiredTools=(
                "chapter.scope_context.build",
                "agent.generate_chapter_beats",
                "draft.batch.create",
                "draft.batch.approve_outline",
                "draft.batch.get",
                "draft.batch.prepare_regeneration",
                "draft.batch.mark_failed",
                "chapter.generate_draft",
            ),
            sideEffect="draft_write",
            supportedOperations=("chapter.batch_rewrite",),
            intentHints=("批量改写章节", "改写多章", "重写选中章节", "batch rewrite"),
            budget=ToolchainBudget(maxToolCalls=12, maxModelCalls=11, maxEstimatedTokens=160000, timeoutSeconds=1200),
        ),
        ToolchainDefinition(
            id="creative_asset.draft",
            version="1.0.0",
            title="创作素材草稿",
            description="读取现有项目资料、检查冲突并生成和校验可审核的创作素材 DraftSession。",
            inputModel=CreativeAssetDraftInput,
            outputModel=DraftToolchainResult,
            allowedRoles=("team", "writer", "editor", "worldbuilding"),
            requiredTools=(
                "plotline.list",
                "character.list",
                "worldsetting.list",
                "item.list",
                "map.list",
                "creative_assets.generate_draft",
                "creative_assets.validate_draft",
            ),
            sideEffect="draft_write",
            supportedOperations=("creative_asset.draft",),
            intentHints=("新增大纲", "新增角色", "补充设定", "世界观", "creative asset"),
            budget=ToolchainBudget(maxToolCalls=7, maxModelCalls=1, maxEstimatedTokens=24000, timeoutSeconds=360),
        ),
        ToolchainDefinition(
            id="plotline.analysis",
            version="1.0.0",
            title="情节线分析",
            description="按用户确认的章节、卷或全书范围，分批分析主支线推进、伏笔回收与长期停滞项。",
            inputModel=PlotlineAnalysisInput,
            outputModel=PlotlineAnalysisArtifact,
            allowedRoles=("team", "writer", "editor", "reader", "worldbuilding"),
            requiredTools=(
                "plotline.list",
                "volume.list",
                "chapter.list",
                "chapter.get",
                "rag.ask",
            ),
            sideEffect="read_only",
            supportedOperations=("plotline.analysis",),
            intentHints=("情节线分析", "主线支线", "伏笔回收", "长期停滞", "plotline analysis"),
            budget=ToolchainBudget(
                maxToolCalls=24,
                maxModelCalls=1,
                maxEstimatedTokens=60000,
                timeoutSeconds=600,
            ),
        ),
    ]
)
