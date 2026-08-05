from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from ..intent.operations import INTENT_OPERATION_REGISTRY
from ..roles import ALLOWED_ROLES
from ..toolchains.registry import TOOLCHAIN_REGISTRY
from .errors import AgentSkillError
from .schemas import AgentSkillDefinition, AgentSkillIndexEntry, AgentSkillRevision


@dataclass(frozen=True)
class AgentSkillRegistration:
    definition: AgentSkillDefinition
    revisions: tuple[AgentSkillRevision, ...]
    localized_titles: dict[str, str]
    localized_descriptions: dict[str, str]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_revision(
    *,
    skill_id: str,
    revision_id: str,
    version: str,
    instructions: str,
    constraints: tuple[str, ...] = (),
    examples: tuple[Any, ...] = (),
    manifest: dict[str, Any] | None = None,
    created_at: str | None = None,
) -> AgentSkillRevision:
    payload = {
        "skillId": skill_id,
        "revisionId": revision_id,
        "version": version,
        "instructions": instructions,
        "constraints": list(constraints),
        "examples": [item.model_dump() if hasattr(item, "model_dump") else item for item in examples],
        "manifest": manifest or {},
    }
    return AgentSkillRevision(
        **payload,
        contentHash=_canonical_hash(payload),
        createdAt=created_at or _utc_now(),
    )


def _version_key(version: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise AgentSkillError("AGENT_SKILL_SCHEMA_INVALID", f"Invalid semantic version: {version}")
    return tuple(int(part) for part in version.split("."))  # type: ignore[return-value]


class AgentSkillRegistry:
    def __init__(self, registrations: Iterable[AgentSkillRegistration]) -> None:
        self._registrations: dict[str, AgentSkillRegistration] = {}
        self._by_stable_id: dict[str, str] = {}
        for registration in registrations:
            self._validate_registration(registration)
            definition = registration.definition
            if definition.id in self._registrations:
                raise AgentSkillError("AGENT_SKILL_DUPLICATE_ID", f"Duplicate Agent Skill id: {definition.id}")
            stable_key = f"{definition.scope}:{definition.ownerNovelId or ''}:{definition.stableId}"
            if stable_key in self._by_stable_id:
                raise AgentSkillError(
                    "AGENT_SKILL_DUPLICATE_STABLE_ID",
                    f"Duplicate Agent Skill stableId in scope: {definition.stableId}",
                )
            self._registrations[definition.id] = registration
            self._by_stable_id[stable_key] = definition.id

    def _validate_registration(self, registration: AgentSkillRegistration) -> None:
        definition = registration.definition
        if not registration.revisions:
            raise AgentSkillError("AGENT_SKILL_REVISION_NOT_FOUND", f"Skill has no revisions: {definition.id}")
        unknown_roles = set(definition.allowedRoles) - ALLOWED_ROLES
        if unknown_roles:
            raise AgentSkillError(
                "AGENT_SKILL_ROLE_NOT_ALLOWED",
                f"Unknown Agent Skill roles: {', '.join(sorted(unknown_roles))}",
            )
        unknown_operations = [item for item in definition.supportedOperations if not INTENT_OPERATION_REGISTRY.has(item)]
        if unknown_operations:
            raise AgentSkillError(
                "AGENT_SKILL_OPERATION_UNSUPPORTED",
                f"Unknown Agent Skill operations: {', '.join(unknown_operations)}",
            )
        known_toolchains = {item["id"] for item in TOOLCHAIN_REGISTRY.list_public()}
        unknown_toolchains = set(definition.recommendedToolchains) - known_toolchains
        if unknown_toolchains:
            raise AgentSkillError(
                "AGENT_SKILL_TOOLCHAIN_UNAVAILABLE",
                f"Unknown recommended Toolchains: {', '.join(sorted(unknown_toolchains))}",
            )
        revision_ids: set[str] = set()
        versions: set[str] = set()
        for revision in registration.revisions:
            if revision.skillId != definition.id:
                raise AgentSkillError("AGENT_SKILL_SCHEMA_INVALID", "Revision skillId does not match Definition id")
            if revision.revisionId in revision_ids or revision.version in versions:
                raise AgentSkillError("AGENT_SKILL_REVISION_CONFLICT", f"Duplicate revision for {definition.id}")
            revision_ids.add(revision.revisionId)
            versions.add(revision.version)
            _version_key(revision.version)

    def get(self, skill_id: str) -> AgentSkillRegistration | None:
        direct = self._registrations.get(skill_id)
        if direct:
            return direct
        matches = [item for item in self._registrations.values() if item.definition.stableId == skill_id]
        return matches[0] if len(matches) == 1 else None

    def registrations(self) -> tuple[AgentSkillRegistration, ...]:
        return tuple(self._registrations.values())

    def require(self, skill_id: str) -> AgentSkillRegistration:
        registration = self.get(skill_id)
        if not registration:
            raise AgentSkillError("AGENT_SKILL_NOT_FOUND", f"Agent Skill not found: {skill_id}")
        return registration

    def revision(self, skill_id: str, revision_id: str | None = None) -> AgentSkillRevision:
        registration = self.require(skill_id)
        if revision_id:
            revision = next((item for item in registration.revisions if item.revisionId == revision_id), None)
            if not revision:
                raise AgentSkillError(
                    "AGENT_SKILL_VERSION_UNAVAILABLE",
                    f"Agent Skill revision unavailable: {registration.definition.stableId}@{revision_id}",
                )
            return revision
        return max(registration.revisions, key=lambda item: _version_key(item.version))

    def list_index(self, *, locale: str = "zh-CN", novel_id: str | None = None) -> list[AgentSkillIndexEntry]:
        language = "en" if locale.lower().startswith("en") else "zh"
        entries: list[AgentSkillIndexEntry] = []
        for registration in self._registrations.values():
            definition = registration.definition
            if definition.scope == "novel" and definition.ownerNovelId != novel_id:
                continue
            revision = self.revision(definition.id)
            entries.append(
                AgentSkillIndexEntry(
                    id=definition.id,
                    stableId=definition.stableId,
                    title=registration.localized_titles.get(language, definition.title),
                    description=registration.localized_descriptions.get(language, definition.description),
                    scope=definition.scope,
                    ownerNovelId=definition.ownerNovelId,
                    category=definition.category,
                    guidanceMode=definition.guidanceMode,
                    semanticSelection=definition.semanticSelection,
                    triggerHints=list(definition.triggerHints),
                    antiTriggerHints=list(definition.antiTriggerHints),
                    allowedRoles=list(definition.allowedRoles),
                    supportedOperations=list(definition.supportedOperations),
                    version=revision.version,
                    revisionId=revision.revisionId,
                    enabled=definition.enabled,
                )
            )
        return sorted(entries, key=lambda item: (item.scope, item.title.casefold(), item.stableId))


CONTINUITY_REVIEW_DEFINITION = AgentSkillDefinition(
    id="builtin.continuity-review",
    stableId="builtin.continuity-review",
    title="连续性审查",
    description="在审核章节前后矛盾时，按时间、地点、人物状态、物品和世界规则逐项核对证据并输出可修复问题。",
    scope="builtin",
    category="review",
    origin="builtin",
    guidanceMode="strict",
    semanticSelection="suggest",
    triggerHints=("检查当前章节是否存在前后矛盾", "审核人物状态、时间线或设定连续性"),
    antiTriggerHints=("续写当前章节", "只评价文风是否优美"),
    allowedRoles=("team", "editor", "reader", "worldbuilding"),
    supportedOperations=("chapter.consistency_review",),
    recommendedToolchains=("chapter.consistency_review",),
    contextNeeds=("current_chapter", "adjacent_chapters", "plotlines", "characters", "worldsettings", "items"),
    outputType="report",
)

CONTINUITY_REVIEW_REVISION = build_revision(
    skill_id=CONTINUITY_REVIEW_DEFINITION.id,
    revision_id="builtin.continuity-review@1.0.0",
    version="1.0.0",
    instructions=(
        "先从章节正文和项目资料建立可引用的事实表，再分别检查时间顺序、地点转换、人物状态、"
        "物品归属、情节因果和世界规则。每个问题必须指出冲突双方、证据位置、严重度、不确定性和最小修复建议。"
        "资料不足时标记无法检查，不得用常识补写项目事实。"
    ),
    constraints=(
        "只报告有正文或项目资料证据支持的问题。",
        "区分确定冲突、疑似冲突和资料不足。",
        "不要把个人偏好或文风建议伪装成连续性错误。",
        "修复建议不得改变用户未要求改动的核心剧情。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3]},
    created_at="2026-08-04T00:00:00Z",
)

NOVEL_BOOTSTRAP_DEFINITION = AgentSkillDefinition(
    id="builtin.novel-bootstrap",
    stableId="builtin.novel-bootstrap",
    title="新建小说",
    description="先以题材、主角和核心冲突建立新书定位，再由模型依据已确认信息自适应追问深度定制项；形成可审核蓝图后，将故事线、大纲、角色、物品与世界设定映射为产品素材草稿。",
    scope="builtin",
    category="generation",
    origin="builtin",
    guidanceMode="guided",
    semanticSelection="auto",
    triggerHints=("新建一本小说", "从零创建小说方案", "开一本新书"),
    antiTriggerHints=("在当前小说中新建章节", "只修改当前小说标题"),
    allowedRoles=("team", "writer", "worldbuilding"),
    supportedOperations=("novel.bootstrap", "novel.project_initialize"),
    recommendedToolchains=("novel.bootstrap", "novel.project_initialize"),
    contextNeeds=("user_decisions", "approved_novel_blueprint", "project_structure"),
    outputType="creative_assets_draft",
)

NOVEL_BOOTSTRAP_REVISION = build_revision(
    skill_id=NOVEL_BOOTSTRAP_DEFINITION.id,
    revision_id="builtin.novel-bootstrap@1.0.0",
    version="1.0.0",
    instructions=(
        "先使用产品内置的提问与推荐机制确认高影响方向；每个问题只覆盖一个真正互斥的取舍，推荐项必须说明理由，"
        "允许用户自定义。根据确认结果形成题材与读者承诺、核心命题、主角欲望与代价、关键关系、世界规则、"
        "主要冲突升级路径、悬念与信息释放策略、首卷结构和开篇章节节拍。所有内容先作为可审核方案，不声称已经写入项目。"
    ),
    constraints=(
        "不得绕过提问卡替用户决定会显著改变故事形态的方向。",
        "已有答案足够时不得重复提问；跳过问题时采用并标明推荐项。",
        "区分用户明确要求、系统建议和模型补全，不把补全内容表述成用户事实。",
        "首轮只产出可审核故事方案，不直接创建数据库记录或生成大段正文。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3], "workflowKind": "builtin_novel_bootstrap"},
    created_at="2026-08-04T00:00:00Z",
)

NOVEL_BOOTSTRAP_PROJECT_INIT_REVISION = build_revision(
    skill_id=NOVEL_BOOTSTRAP_DEFINITION.id,
    revision_id="builtin.novel-bootstrap@1.1.0",
    version="1.1.0",
    instructions=(
        "先使用产品内置的提问与推荐机制确认高影响方向；每个问题只覆盖一个真正互斥的取舍，推荐项必须说明理由，"
        "允许用户自定义。先形成包含题材承诺、核心命题、人物欲望与代价、关系、世界规则、冲突升级、悬念策略、"
        "分卷路线与开篇章节节拍的可审核蓝图。蓝图确认后，调用 novel.project_initialize：将蓝图作为结构化来源，"
        "生成故事线、情节点、角色、物品、技能、世界设定和地图/地点的可审核项目素材草稿。所有素材必须复用产品原生字段，"
        "并在提交前经由创作素材审核面板逐项确认。"
    ),
    constraints=(
        "不得绕过提问卡替用户决定会显著改变故事形态的方向。",
        "已有答案足够时不得重复提问；跳过问题时采用并标明推荐项。",
        "区分用户明确要求、系统建议和模型补全，不把补全内容表述成用户事实。",
        "蓝图确认前不得创建项目素材草稿；初始化阶段不得直接写入正式项目记录。",
        "初始化只能调用已登记的项目工具，并把结果保留为可审核、可撤销的创作素材草稿。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3, 4], "workflowKind": "builtin_novel_bootstrap_project_initialize"},
    created_at="2026-08-05T00:00:00Z",
)

NOVEL_BOOTSTRAP_GENRE_FIRST_REVISION = build_revision(
    skill_id=NOVEL_BOOTSTRAP_DEFINITION.id,
    revision_id="builtin.novel-bootstrap@1.2.0",
    version="1.2.0",
    instructions=(
        "先按两层递进式问答完成新书定位。第一层必须依次确认题材与核心创意、主角设定、核心冲突；"
        "第二层再确认世界范围、叙事视角和连载规模。每个问题只覆盖一个真正互斥的取舍，推荐项必须说明理由，"
        "允许用户自定义或跳过；跳过时采用并标明推荐项。题材答案是用户事实：genrePromise 必须明确保留其题材与创意，"
        "不得改写成另一种题材。再生成包含题材承诺、核心命题、人物欲望与代价、关系、世界规则、冲突升级、悬念策略、"
        "分卷路线、开篇章节节拍和写作建议的可审核蓝图。蓝图确认后，调用 novel.project_initialize：将蓝图作为结构化来源，"
        "生成故事线、情节点、角色、物品、技能、世界设定和地图/地点的可审核项目素材草稿；所有素材必须复用产品原生字段，"
        "并在提交前经由创作素材审核面板逐项确认。"
    ),
    constraints=(
        "不得绕过题材、主角或核心冲突提问卡，不得在这些高影响方向上替用户决定。",
        "已有答案足够时不得重复提问；跳过问题时采用并标明推荐项。",
        "区分用户明确要求、系统建议和模型补全，不把补全内容表述成用户事实。",
        "蓝图确认前不得创建项目素材草稿；初始化阶段不得直接写入正式项目记录。",
        "初始化只能调用已登记的项目工具，并把结果保留为可审核、可撤销的创作素材草稿。",
        "不得把项目尚不支持的并行全书直写伪装为已执行能力；后续正文必须通过章节草稿与审核工具链。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3, 4, 5], "workflowKind": "builtin_novel_bootstrap_genre_first"},
    created_at="2026-08-05T00:00:00Z",
)

NOVEL_BOOTSTRAP_ADAPTIVE_INTERVIEW_REVISION = build_revision(
    skill_id=NOVEL_BOOTSTRAP_DEFINITION.id,
    revision_id="builtin.novel-bootstrap@1.3.0",
    version="1.3.0",
    instructions=(
        "按递进创作流程启动新书。第一层必须依次确认题材与核心创意、主角设定、核心冲突；题材答案是用户事实，"
        "genrePromise 必须明确保留其题材与创意，不得改写成另一种题材。进入第二层后，读取完整问答历史，"
        "由模型识别仍会实质改变项目蓝图的缺口并自适应追问，不得把世界范围、叙事视角、主题、读者定位或连载规模"
        "写成固定问卷；已有答案或跳过后采用的推荐项不得重复追问。信息足够时结束访谈并生成包含题材承诺、"
        "核心命题、人物欲望与代价、关系、世界规则、冲突升级、悬念策略、分卷路线和开篇章节节拍的可审核蓝图。"
        "蓝图确认后调用 novel.project_initialize，将蓝图映射为故事线、情节点、角色、物品、技能、世界设定和地图/地点"
        "的原生项目素材草稿，再由创作素材审核面板逐项确认。后续正文通过章节草稿、续写和质量审核工具链执行。"
    ),
    constraints=(
        "不得绕过题材、主角或核心冲突提问卡，不得在这些高影响方向上替用户决定。",
        "深度定制必须使用所有已确认答案判断缺口；每轮只问 1 至 3 个真正独立的高影响取舍，最多两轮。",
        "已有答案足够、已跳过或已采用推荐项时不得重复提问；不要为了凑足问题而虚构缺口。",
        "区分用户明确要求、系统建议和模型补全，不把补全内容表述成用户事实。",
        "蓝图确认前不得创建项目素材草稿；初始化阶段不得直接写入正式项目记录。",
        "初始化只能调用已登记的项目工具，并把结果保留为可审核、可撤销的创作素材草稿。",
        "不得把项目尚不支持的并行全书直写伪装为已执行能力；后续正文必须通过章节草稿与审核工具链。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3, 4, 5, 6], "workflowKind": "builtin_novel_bootstrap_adaptive_interview"},
    created_at="2026-08-05T00:00:00Z",
)

STYLE_SKILL_EXTRACTOR_DEFINITION = AgentSkillDefinition(
    id="builtin.style-skill-extractor",
    stableId="builtin.style-skill-extractor",
    title="文风 Skill 提炼",
    description="从获准的小说样本中分维度提炼语言风格、悬念与信息释放，并在证据充分时提炼群像人物推进方法，形成 Skill Pack 草稿。",
    scope="builtin",
    category="style",
    origin="builtin",
    guidanceMode="strict",
    semanticSelection="auto",
    triggerHints=("根据小说样本提炼文风 Skill", "抽取语言风格和悬念组织方法", "创建文风技能包"),
    antiTriggerHints=("按已有文风直接续写", "只评价文笔好坏"),
    allowedRoles=("team", "writer", "editor", "reader"),
    supportedOperations=("agent_skill.style_extract",),
    recommendedToolchains=("agent_skill.style_extract",),
    contextNeeds=("chapter_scope", "source_coverage"),
    outputType="report",
)

STYLE_SKILL_EXTRACTOR_REVISION = build_revision(
    skill_id=STYLE_SKILL_EXTRACTOR_DEFINITION.id,
    revision_id="builtin.style-skill-extractor@1.0.0",
    version="1.0.0",
    instructions=(
        "先记录来源范围、样本覆盖和不确定性，再将可复用方法拆成独立草稿：一、语言风格，覆盖句长与节奏、叙述距离、"
        "视角、用词密度、对白、描写、修辞和段落组织；二、悬念与信息释放，覆盖问题建立、线索密度、误导、"
        "揭示节拍、章末钩子和读者认知差；三、只有样本确实包含多人物并行推进时，才生成群像人物推进草稿，"
        "覆盖视角轮换、角色目标、交汇节点、出场节奏和辨识度。最后生成按 Operation/Role 绑定上述成员的 Skill Pack 草稿。"
    ),
    constraints=(
        "提炼可复用方法，不复制来源中的长句、专有名词、人物或情节。",
        "每项规则必须关联样本证据类型或明确标记为低置信度推断。",
        "语言风格、悬念方法和群像推进必须保持为独立 Skill 草稿；Pack 不得合并成一段 composite Prompt。",
        "证据不足时省略群像草稿；只有作品名称或模型先验时不得输出高置信度结论。",
        "输出包含正向触发样例、反向触发样例、适用 Operation、指导自由度、污染警告和独立试运行建议。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3, 4], "draftKind": "multi_dimensional_style_pack"},
    created_at="2026-08-04T00:00:00Z",
)

BUILTIN_AGENT_SKILL_REGISTRY = AgentSkillRegistry(
    [
        AgentSkillRegistration(
            definition=CONTINUITY_REVIEW_DEFINITION,
            revisions=(CONTINUITY_REVIEW_REVISION,),
            localized_titles={"zh": "连续性审查", "en": "Continuity Review"},
            localized_descriptions={
                "zh": CONTINUITY_REVIEW_DEFINITION.description,
                "en": "Use evidence to review timeline, location, character state, item, causality, and world-rule continuity.",
            },
        ),
        AgentSkillRegistration(
            definition=NOVEL_BOOTSTRAP_DEFINITION,
            revisions=(
                NOVEL_BOOTSTRAP_REVISION,
                NOVEL_BOOTSTRAP_PROJECT_INIT_REVISION,
                NOVEL_BOOTSTRAP_GENRE_FIRST_REVISION,
                NOVEL_BOOTSTRAP_ADAPTIVE_INTERVIEW_REVISION,
            ),
            localized_titles={"zh": "新建小说", "en": "New Novel Blueprint"},
            localized_descriptions={
                "zh": NOVEL_BOOTSTRAP_DEFINITION.description,
                "en": "Confirm high-impact choices, produce a reviewable blueprint, then initialize native project asset drafts after approval.",
            },
        ),
        AgentSkillRegistration(
            definition=STYLE_SKILL_EXTRACTOR_DEFINITION,
            revisions=(STYLE_SKILL_EXTRACTOR_REVISION,),
            localized_titles={"zh": "文风 Skill 提炼", "en": "Writing Style Skill Extractor"},
            localized_descriptions={
                "zh": STYLE_SKILL_EXTRACTOR_DEFINITION.description,
                "en": "Extract language style, suspense and information release, plus optional ensemble progression into a reviewable Skill Pack draft.",
            },
        ),
    ]
)
