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
        self.validate_definition(definition)
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

    @staticmethod
    def validate_definition(definition: AgentSkillDefinition) -> None:
        """Validate catalog capabilities without loading method bodies."""
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

CHARACTER_COGNITION_DEFINITION = AgentSkillDefinition(
    id="builtin.character-cognition",
    stableId="builtin.character-cognition",
    title="人物认知与行为",
    description="按故事时点和实际处境组织人物行动与对白，核对推断、反转的依据；按场景作用取舍细节与比喻，减少空转对峙、刻意专业和重复解释。",
    scope="builtin",
    category="narrative_method",
    origin="builtin",
    guidanceMode="guided",
    semanticSelection="auto",
    triggerHints=("让人物的选择与对白符合当时处境", "检查人物提前知道信息或行为动机不足", "按时间线补全人物认知和关系变化", "减少无用细节、动作碎拆与重复解释", "检查对峙空转、反转前提和规则约束"),
    antiTriggerHints=("只改错别字或排版", "从其他小说提炼文风", "只查询人物名字或章节目录"),
    allowedRoles=("team", "writer", "editor", "reader", "worldbuilding"),
    supportedOperations=(
        "chapter.continuation", "chapter.create", "chapter.rewrite", "chapter.sequence_continuation", "chapter.batch_rewrite",
        "chapter.consistency_review", "writer.range_revision_plan", "editor.range_review",
        "reader.feedback", "reader.journey_review", "worldbuilding.range_consistency", "creative_asset.draft",
    ),
    contextNeeds=("current_chapter", "characters", "plotlines", "chapter_summaries", "research_evidence"),
    outputType="none",
)

CHARACTER_COGNITION_REVISION = build_revision(
    skill_id=CHARACTER_COGNITION_DEFINITION.id,
    revision_id="builtin.character-cognition@1.0.0",
    version="1.0.0",
    instructions="""先确认任务是写作、修订、审核还是人物资料补全，遵守该任务的输出格式。只处理本场相关人物与关键选择，不要求每句话、每个配角都填写表格。

### 按故事时点建立人物所知
区分事件发生时间、人物获知时间和叙述位置；章节号不是故事时间，倒叙中的人物只能使用那时已得知的信息。同章内也要随观察、对话、读信等动作更新认知：入场不知道，不等于整章都不能知道；章末知道，不等于章首已经知道。
把客观事实、作者计划、人物亲见、他人转述、人物相信/怀疑的内容分开。人物可能相信假话，也可能知道别人说错却选择不揭穿；读者或别的角色知道的事不自动共享。新证据可以纠正误解，遗忘和迟疑要有情境，不把认知当作只增不减的清单。
对影响选择的信息，保留人物、内容、获知时点、来源或正文位置、可信程度；时点不明就标为不明，不能因事件发生在过去便推定人物早已知道。只使用当前有效的正文版本/分支；废弃草稿、被重写章节的旧结论和未来计划不作为既成经历。
优先读取已给的相关材料。确有关键缺口且工具可用时，按人物、问题和场景时间检索并回查原段，判断该角色是否在场、被告知或有其他获知途径。语义相关不代表该人物当时可知；无检索结果也不证明他不知道。没有工具或依据不足时如实保留缺口，不声称已经做过检索或时间过滤。

### 从处境推进行动
围绕当前重要选择，联系长期欲望与眼前目的、怕失去的东西、对他人的期待，以及实际技能、权限、资源、距离和时间。会做与做得到不同，人物也可能高估能力或误判代价。
允许爱欲、嫉妒、羞耻、怨恨、愧疚、疲惫、冲动、习惯和面子改变选择，不要求人人理性、勇敢或说真话，不强迫每场都有情绪清单。问：拿掉作者想要的剧情结果，在人物当时的理解下，这个选择还说得通吗？若说不通，优先调整行动或补必要的可观察诱因，不临时发明决定性往事、特殊能力或秘密来替草稿圆场。人物转变可以发生，但需有经历或当场压力作为连接。
为关键动作建立足够的前因和后果：为什么此刻查看、询问、回避、冒险，行动获得的信息如何影响下一步。正常办事、亲近相处与休息也能成立，不把全部动作改成调查、博弈或悬念。

### 让不同的人说自己的话
依据已有经历、职业、关系和当下目的选择称呼、用词、解释习惯、直接或迂回的程度。同一人面对上司、亲人或陌生人可以不同；不要只分配口头禅、句长或固定情绪。对白可有闲话、误会、玩笑、恼怒和欲言又止，但隐瞒要有本人的理由。知道且愿意说的可以直说，不为制造悬念统一改成警告、停顿和不完整回答。保留自然心理叙述，不把每种情绪换成微动作。

### 随任务交付并审慎沉淀
写作时用上述判断组织正文，只输出任务要求的正文，不附逐步推演、人物卡或自评；规划或补全任务可交付简短场景人物卡及候选设定。资料缺失时可在授权范围内提出兼容候选，标清推测/补全及生效时点，不能冒充原作事实；重大背景会改变核心剧情时先列出缺口。
审核时定位具体句段，以当时可用证据区分确定冲突、需要铺垫、证据不足和可选表达。给最小修复，不把非理性、说谎、普通闲话、性格变化或与审稿者偏好不同直接判错。不能由一句台词或一次行动推定永久人格。
章节采用后可提取状态增量：谁在何时通过什么得知/相信/修正了什么，关系、承诺和资源有何变化；绑定正文版本和证据。草稿中的增量先留在草稿，人物稳定设定另列候选，未通过实际工具保存不得声称已入库。正文重写或撤销时，相关派生状态需失效或重算；本Skill只规定方法，不等于系统已实现自动记忆和时间过滤。

中性例：钥匙昨晚丢失，阿宁上午仍以为在包里，中午收到“门卫捡到”的消息，下午才发现消息发错人。上午她会翻包；中午可据此去门卫处，即使消息客观为假；下午应修正找钥匙的方向。倒叙回上午不能借用下午结论。急着赴约而没先核实消息，是可理解的选择，不自动算智力或性格错误。""",
    constraints=(
        "以当前有效版本及场景时点区分客观事实、作者计划和人物认知；不能把未来获知倒灌为早先知识。",
        "同一章的认知随有依据的观察与交流更新；允许错误信念及被新证据纠正，不把场景入口状态冻结到结尾。",
        "没有证据不得伪造既定经历、检索结果或已保存状态；补全明确标为候选，不为错误正文补设定圆场。",
        "写作交付正文，审核交付有依据的判断；不强制理性选择、固定口吻或每场填写整套人物表。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3]},
    created_at="2026-10-17T00:00:00Z",
)

CHARACTER_COGNITION_DETAIL_REVISION = build_revision(
    skill_id=CHARACTER_COGNITION_DEFINITION.id,
    revision_id="builtin.character-cognition@1.1.0",
    version="1.1.0",
    instructions=CHARACTER_COGNITION_REVISION.instructions.replace(
        "### 随任务交付并审慎沉淀",
        """### 按场景作用取舍细节
人物知道的、作者想得到的，不必全部写出来。选择能帮助读者理解当下行动、人物关系、情绪变化、悬念或场景感受的内容；一个细节合理、真实或可以解释得通，不等于值得占用正文。采用已有文风和用户要求的信息密度，不为显得具体而堆细节，也不把这项判断变成逐句说明用途的表格。
专业对白先考虑对方需要知道什么、能听懂什么。交代实际影响或下一步怎么做；只有诊断、协作、冲突或人物表达确实需要时，才展开部件名称和操作步骤。比如只需让新来的人等待，可说“等我修好”；提醒车不能开，要说清“刹车不太灵，今晚先别开”，不要用含义不清的术语代替后果，也不为消除术语凭空补造故障。
普通动作按读者需要概括或省略，不默认拆成停住、抬手、合上、放回等连续镜头；没有新增意味时，“拍完，他把日志放了回去”已经足够，过渡本身不重要也可以不写。过程中的悬念、阻碍、犹豫、藏匿或承诺确实重要时，再展开相关动作；不能把有后果的上锁、交接等事实一并抹掉。
背景声、物件与感官描写应参与这一场戏，或形成有辨识度的氛围；不要习惯性添加电视声、碗筷轻响等环境填充。人物处境已清楚时，无需把背景声逐项报出；声音如果打断对话、暴露在场者、改变人物判断或承载关系意味，应保留。生活细节无需都推动主线，但不能仅以“增加真实感”为由无限添加。
对白或行动已经让读者明白的意思，不默认再用心理叙述解释一遍，再用总结收尾。回想、重复和心理叙述若增加新的误解、情绪、关联或决定，可以保留；没有增量时，允许合并句段、改顺衔接或省略整句，不限于逐字删减。日志、清单和操作格式只交代读者需要的结果，避免无关条目枚举和让人额外解码的数量说明。
修订时指出原句造成的具体阅读负担，以及删并会不会丢掉线索、声音或情绪；不为每个细节臆造一种可能用途来拒绝修改，也不把所有表达都压成短句或剧情梗概。减少字数不是目标，保留必要信息后的自然表达才是目标。这些是表达取舍，不能伪装成确定的事实冲突，绕过修订权限或强行自动改稿。

### 随任务交付并审慎沉淀""",
    ),
    constraints=CHARACTER_COGNITION_REVISION.constraints + (
        "按当下场景作用选择细节；减少刻意专业、无用动作碎拆、环境填充与重复释义，保留有作用的线索、情绪和人物声音，不机械追求少字或短句。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3, 4]},
    created_at="2026-10-17T00:00:00Z",
)

CHARACTER_COGNITION_SCENE_REVISION = build_revision(
    skill_id=CHARACTER_COGNITION_DEFINITION.id,
    revision_id="builtin.character-cognition@1.2.0",
    version="1.2.0",
    instructions=CHARACTER_COGNITION_DETAIL_REVISION.instructions.replace(
        "### 随任务交付并审慎沉淀",
        """### 让交锋与反转有实际支撑
按一段交锋而非每句台词，检查信息、关系、情绪、决定或可行动空间发生了什么变化。威胁、试探、闲话和嘴硬可以成立；若多轮只在重复“你怕我”“我看穿了你”，局势没有变化，就压缩、合并或转入行动。拖延本身是策略时，要有拖延的目的与正在付出的代价，不靠反复眯眼、冷笑、沉默和神秘口气假装局势推进。人物可以逞强，但叙述不能仅凭漂亮台词就判定谁聪明、谁获胜。
推断和反转必须有已经成立的前提。揭晓前回查决定结果的旧对白、行动经过、空间关系和规则：声称对方提过某人、走过两扇门，就要能在当前有效材料中找到依据；没有依据，不能为成就反转临时补成既成事实。人物可以撒谎、诈唬或误判，但其断言不自动成为叙述确认的真相。允许隐藏计划与延迟揭示，关键条件须事先成立，揭晓能与前文兼容；不要求提前公开答案，也不强求复刻参考作品的情节。关键材料缺失时回查或保留未知，不猜一条足以决定胜负的新规则。
规则类场景按需要在内部核对回合、行动代价、门锁、位置与移动顺序，只把读者理解局势所需的变化写出来，不逐步播报完整账本。若反转依赖一次折返、换位或开门，不能到揭晓时才追加未成立的关键步骤。悬念来自人物掌握不同信息、作出选择及承担后果，而不只是故意含糊的语气。
伤势、窒息、疲惫、距离、资源与技能必须实际限制人物能做什么、说多久、判断到哪一步。允许忍痛、冒险和超常能力，但表现要与已建立的能力和代价兼容；不能刚写无法站立，交锋时却无交代地恢复长篇演说和灵活动作。无需反复描写伤口，限制可以表现为行动失败、改变办法、求助或留下后果。

### 让比喻增加理解而非装饰
比喻、类比和“像……”应增加具体感受、人物视角或对局势的理解。若只是把已写出的低声再说成“像在说悄悄话”，或用“像在盘算什么”“让人摸不透的笑”泛泛暗示深意，优先直接表达、写出可观察变化或省略；视角人物确实看不清、猜不准时可以保留不确定性，不为去掉含糊而赋予全知。判断删去比喻是否损失了有价值的内容，不按词频配额禁用“像”，也不机械改成另一种比喻。
审核时分别判断表达负担、推断依据和行动可行性。区分已知材料里的矛盾与未展示片段造成的证据缺口；文学表达建议仍不能冒充确定冲突。优先修正前提、过程或选择，再调整措辞，不能仅删几个比喻便声称修好了无依据的反转。

### 随任务交付并审慎沉淀""",
    ),
    constraints=CHARACTER_COGNITION_DETAIL_REVISION.constraints + (
        "交锋应有信息、关系、情绪或行动上的作用；反转不补造已发生的关键事实，人物推断和诈唬不自动成为客观真相。",
        "规则、空间、伤势与资源实际约束行动；比喻应增加理解或感受，不用神秘姿态代替局势与因果。",
    ),
    manifest={"coreConstraints": [0, 1, 2, 3, 4, 5, 6]},
    created_at="2026-10-18T00:00:00Z",
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

STYLE_SKILL_EXTRACTOR_WORKSPACE_REVISION = build_revision(
    skill_id=STYLE_SKILL_EXTRACTOR_DEFINITION.id,
    revision_id="builtin.style-skill-extractor@1.1.0",
    version="1.1.0",
    instructions=(
        "先记录获准来源的范围、样本覆盖、缺口和不确定性，只生成有界成员规划，不在规划协议中编写长篇 Skill 正文。"
        "规划必须包含语言风格、悬念与信息释放；只有样本确实包含多人物并行推进时，才增加群像人物推进。语言风格的"
        "方法维度覆盖句长与节奏、叙述距离、视角、用词密度、对白、描写、修辞和段落组织；悬念维度覆盖问题建立、"
        "线索、误导、揭示节拍、章末钩子和读者认知差；群像维度覆盖视角轮换、角色目标、交汇节点、出场节奏和辨识度。"
        "规划确认后，把每个成员分别写入同一可恢复草稿工作区的独立 SKILL.md，并通过小型 Skill Pack 绑定关联 Operation/Role。"
        "每个文档都要包含清楚的正反触发边界、可执行方法、质量标准、证据边界、污染警告与中性试运行建议。"
    ),
    constraints=(
        "提炼抽象、可复用的方法，不复制来源中的长句、专有名词、人物、设定或情节。",
        "每项结论关联样本证据类型或明确标记为低置信度推断；只有作品名称或模型先验时不得输出高置信度结论。",
        "语言风格、悬念方法和可选群像推进必须保持为独立文档；Pack 不得合并为 composite Prompt。",
        "规划对象只承载短元数据、方法维度、来源覆盖和绑定，不得承载多个 Skill 的长正文。",
        "校验失败时只修订诊断指向的成员文档，保留已经合法的成员和已读取来源，不重新生成整个 Pack。",
        "不得安装、启用、提交或直接写入正式 Skill；确定性编译通过后仍需用户审核。",
    ),
    manifest={
        "coreConstraints": [0, 1, 2, 3, 4, 5],
        "draftKind": "multi_dimensional_style_pack",
        "authoringMode": "sqlite_workspace_documents",
    },
    created_at="2026-08-22T00:00:00Z",
)

STYLE_SKILL_EXTRACTOR_ADAPTIVE_REVISION = build_revision(
    skill_id=STYLE_SKILL_EXTRACTOR_DEFINITION.id,
    revision_id="builtin.style-skill-extractor@1.2.0", version="1.2.0",
    instructions=("先解析获准章节目录，再按原文工作单元提炼带来源定位的语言、悬念和人物推进特征。"
                  "局部样本不得冒充已验证的跨章悬念轨迹；汇总保留共同特征、反例与缺口。"
                  "成员规划与文档生成只消费汇总特征和相关短证据，不反复携带整本正文。"
                  + STYLE_SKILL_EXTRACTOR_WORKSPACE_REVISION.instructions),
    constraints=STYLE_SKILL_EXTRACTOR_WORKSPACE_REVISION.constraints,
    manifest={**STYLE_SKILL_EXTRACTOR_WORKSPACE_REVISION.manifest, "executionHints": {
        "version": 1, "decomposition": "independent_units", "preferredUnit": "chapter",
        "contextRequirement": "verbatim_samples", "crossUnitDependency": "none",
        "resultComposition": "evidence_findings", "coverageRequirement": "all_units",
    }}, created_at="2026-10-09T00:00:00Z",
)

STYLE_SKILL_EXTRACTOR_QUALITY_REVISION = build_revision(
    skill_id=STYLE_SKILL_EXTRACTOR_DEFINITION.id,
    revision_id="builtin.style-skill-extractor@1.3.0", version="1.3.0",
    instructions=(STYLE_SKILL_EXTRACTOR_ADAPTIVE_REVISION.instructions
        + "专家逐页核对完整候选及逐字短证据；按稳定维度记录独立支持章数、反例和未决项，不能把投影数或发现数当作章节数。"
          "写作成员必须区分应用、修订与诊断：应用既有方法时按目标场景或大纲输出原创正文，不强制重读来源小说。"
          "候选趋势写成条件化方法；无统计依据的固定数值不得伪称来源规律，可调工程建议须明确标注。"
          "成员声明真实注册的操作与允许角色，Pack 主辅成员均须兼容绑定。"
          "正文编写后独立审核任务适配、规则强度、证据、反例、污染和绑定；只定向修订不合格成员。"
          "用同一原创中性场景做无Skill、单成员和Pack试写，并独立对照审核；结果及边界写入草稿，不能仅凭格式校验声称文风有效。"),
    constraints=(*STYLE_SKILL_EXTRACTOR_ADAPTIVE_REVISION.constraints,
        "不将低置信局部观察升级为硬性模板；应用写作须产出新正文。",
        "编写后内容审核与实际对照试写通过才交付可启用候选；不承诺所有场景都还原来源文风。"),
    manifest={**STYLE_SKILL_EXTRACTOR_ADAPTIVE_REVISION.manifest, "qualityAcceptance": "evidence-document-trial-v1"},
    created_at="2026-10-13T00:00:00Z",
)

STYLE_SKILL_EXTRACTOR_FIDELITY_REVISION = build_revision(
    skill_id=STYLE_SKILL_EXTRACTOR_DEFINITION.id,
    revision_id='builtin.style-skill-extractor@1.4.0', version='1.4.0',
    instructions=STYLE_SKILL_EXTRACTOR_QUALITY_REVISION.instructions.replace(
        '规划必须包含语言风格、悬念与信息释放；', '规划语言风格核心；只有来源证据支持时才增加悬念与信息释放；').replace(
        '用同一原创中性场景做无Skill、单成员和Pack试写', '用互动和过渡两个原创中性场景分别做无Skill、单成员和Pack试写')
        + '先按不同场景建立来源风格画像，句长、段落和对白分布只描述样本，不作为生成配额。'
          '保留来源的长短句变化、心理叙述、叙述者态度和人物语气差异，不以短句、停顿、微动作或谜语问答作为通篇默认。'
          '低置信局部观察不得在输出自检中升级为必须项。中性正例需体现来源特征及正常表达边界，反例同时检查动作填充、密集停顿和机械释疑。'
          '统计与引文存入证据报告，方法正文只保留必要适用边界。保留章节只参与验收，不参与规则编写。'
          '在互动与过渡等不同场景盲评基线、成员和组合，并依据参考片段检查来源一致性与节奏变化，不以检测率或模型自评分替代文本依据。',
    constraints=STYLE_SKILL_EXTRACTOR_QUALITY_REVISION.constraints,
    manifest={**STYLE_SKILL_EXTRACTOR_QUALITY_REVISION.manifest, 'qualityAcceptance': 'evidence-document-trial-v2'},
    created_at='2026-10-14T00:00:00Z',
)

BUILTIN_AGENT_SKILL_REGISTRY = AgentSkillRegistry(
    [
        AgentSkillRegistration(
            definition=CHARACTER_COGNITION_DEFINITION,
            revisions=(CHARACTER_COGNITION_REVISION, CHARACTER_COGNITION_DETAIL_REVISION, CHARACTER_COGNITION_SCENE_REVISION),
            localized_titles={"zh": "人物认知与行为", "en": "Character Cognition and Behavior"},
            localized_descriptions={
                "zh": CHARACTER_COGNITION_DEFINITION.description,
                "en": "Ground choices, dialogue, and reversals in time-specific knowledge, established evidence, and real constraints; select purposeful detail and comparisons instead of repetitive confrontations and explanations.",
            },
        ),
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
            revisions=(STYLE_SKILL_EXTRACTOR_REVISION, STYLE_SKILL_EXTRACTOR_WORKSPACE_REVISION, STYLE_SKILL_EXTRACTOR_ADAPTIVE_REVISION, STYLE_SKILL_EXTRACTOR_QUALITY_REVISION, STYLE_SKILL_EXTRACTOR_FIDELITY_REVISION),
            localized_titles={"zh": "文风 Skill 提炼", "en": "Writing Style Skill Extractor"},
            localized_descriptions={
                "zh": STYLE_SKILL_EXTRACTOR_DEFINITION.description,
                "en": "Extract language style, suspense and information release, plus optional ensemble progression into a reviewable Skill Pack draft.",
            },
        ),
    ]
)
