from __future__ import annotations

from typing import Any

from .schemas import AgentRoleDefinition


ALLOWED_AGENTS = {"supervisor", "writer", "editor", "reader", "worldbuilding", "research_rag"}
ALLOWED_ROLES = ALLOWED_AGENTS | {"team"}


_ROLE_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "team",
        "agent": "supervisor",
        "label": {"zh": "团队", "en": "Team"},
        "description": {"zh": "由监督者协调多个专家完成复杂创作任务。", "en": "Coordinate multiple specialists for complex writing tasks."},
        "tools": ["novel.list", "volume.list", "chapter.list", "chapter.get", "rag.ask", "search.query", "plotline.list", "character.list", "item.list", "worldsetting.list", "map.list", "chapter.generate_draft", "creative_assets.generate_draft"],
        "skills": ["任务拆解", "专家协调", "结果汇总"],
        "presets": [
            {"id": "team-project-audit", "label": {"zh": "项目全局审计", "en": "Project audit"}, "description": {"zh": "检查情节、角色、设定与章节的一致性。", "en": "Audit plot, character, setting, and chapter consistency."}, "goal": {"zh": "读取当前项目资料，进行全局一致性审计，按严重程度列出问题、证据和修改建议。", "en": "Read the current project and perform a consistency audit with prioritized findings, evidence, and fixes."}},
            {"id": "team-continuation-plan", "label": {"zh": "续写准备", "en": "Continuation plan"}, "description": {"zh": "汇总上下文并形成可执行续写方案。", "en": "Gather context and produce an actionable continuation plan."}, "goal": {"zh": "读取当前章节及相关情节、角色和设定，形成下一段续写前的审核清单与建议方向。", "en": "Read the current chapter and related plot, characters, and setting, then prepare a continuation checklist and direction."}},
        ],
    },
    {
        "id": "writer",
        "agent": "writer",
        "label": {"zh": "作者", "en": "Writer"},
        "description": {"zh": "负责正文续写、改写和场景扩展。", "en": "Draft, rewrite, and expand narrative scenes."},
        "tools": ["novel.list", "volume.list", "chapter.list", "chapter.get", "rag.ask", "plotline.list", "character.list", "worldsetting.list", "chapter.generate_draft"],
        "skills": ["正文续写", "场景扩写", "文风保持"],
        "presets": [
            {"id": "writer-continue-chapter", "label": {"zh": "续写当前章节", "en": "Continue chapter"}, "description": {"zh": "基于已有正文和设定生成可审核草稿。", "en": "Create a reviewable draft from current prose and context."}, "goal": {"zh": "读取当前章节、相关情节、角色和设定，续写当前章节并生成可审核的正文草稿。", "en": "Read the current chapter and related context, then continue it as a reviewable prose draft."}, "deliverable": "chapter_draft"},
            {"id": "writer-strengthen-scene", "label": {"zh": "强化当前场景", "en": "Strengthen scene"}, "description": {"zh": "改善冲突、节奏和感官细节。", "en": "Improve conflict, pacing, and sensory detail."}, "goal": {"zh": "审查当前章节的场景表现，保留核心事件，强化冲突、节奏和感官细节，并生成修改草稿。", "en": "Review the current scene, preserve its core events, and generate a stronger draft with improved conflict, pacing, and sensory detail."}, "deliverable": "chapter_draft"},
        ],
    },
    {
        "id": "editor",
        "agent": "editor",
        "label": {"zh": "编辑", "en": "Editor"},
        "description": {"zh": "负责结构、节奏、逻辑和文字质量审校。", "en": "Review structure, pacing, logic, and prose quality."},
        "tools": ["novel.list", "volume.list", "chapter.list", "chapter.get", "rag.ask", "search.query", "plotline.list", "character.list", "worldsetting.list"],
        "skills": ["结构审校", "节奏诊断", "一致性检查"],
        "defaultSkillIds": ["builtin.continuity-review"],
        "presets": [
            {"id": "editor-chapter-audit", "label": {"zh": "章节质量审校", "en": "Chapter review"}, "description": {"zh": "输出按优先级排序的问题与修改建议。", "en": "Produce prioritized findings and revision advice."}, "goal": {"zh": "读取当前章节和必要上下文，从结构、节奏、人物动机、设定一致性和文字表达五方面审校，列出证据与修改建议。", "en": "Review the current chapter for structure, pacing, motivation, setting consistency, and prose, with evidence and recommendations."}},
            {"id": "editor-continuity", "label": {"zh": "连续性检查", "en": "Continuity check"}, "description": {"zh": "检查章节间事实与状态是否冲突。", "en": "Check factual and state continuity across chapters."}, "goal": {"zh": "读取当前章节及相邻章节，检查时间、地点、人物状态、物品和设定的连续性冲突，并给出修复建议。", "en": "Read the current and adjacent chapters, find continuity conflicts in time, place, character state, items, and setting, and suggest fixes."}},
        ],
    },
    {
        "id": "reader",
        "agent": "reader",
        "label": {"zh": "读者", "en": "Reader"},
        "description": {"zh": "模拟真实阅读体验，评估理解、情绪和追更动力。", "en": "Simulate reader experience and assess clarity, emotion, and engagement."},
        "tools": ["novel.list", "volume.list", "chapter.list", "chapter.get", "rag.ask", "plotline.list", "character.list", "worldsetting.list"],
        "skills": ["读者反馈", "悬念评估", "信息负荷诊断"],
        "presets": [
            {"id": "reader-blind-test", "label": {"zh": "读者盲测", "en": "Reader blind test"}, "description": {"zh": "按真实阅读顺序反馈困惑与情绪变化。", "en": "Report confusion and emotional response in reading order."}, "goal": {"zh": "以首次阅读者视角阅读当前章节，按阅读顺序记录理解障碍、情绪变化、有效悬念和出戏点。", "en": "Read the current chapter as a first-time reader and report confusion, emotional shifts, effective suspense, and immersion breaks in order."}},
            {"id": "reader-retention", "label": {"zh": "追更欲望评估", "en": "Retention review"}, "description": {"zh": "判断章节是否足以推动继续阅读。", "en": "Assess whether the chapter motivates continued reading."}, "goal": {"zh": "评估当前章节的开头吸引力、中段推进和结尾钩子，给出追更动力评分及最关键的三项改进。", "en": "Assess the chapter opening, middle progression, and ending hook, then score retention and give the three most important improvements."}},
        ],
    },
    {
        "id": "worldbuilding",
        "agent": "worldbuilding",
        "label": {"zh": "世界观", "en": "Worldbuilding"},
        "description": {"zh": "维护世界规则、角色、物品和空间设定。", "en": "Maintain world rules, characters, items, and spatial setting."},
        "tools": ["novel.list", "volume.list", "chapter.list", "chapter.get", "rag.ask", "character.list", "item.list", "worldsetting.list", "map.list", "creative_assets.generate_draft"],
        "skills": ["规则设计", "设定一致性", "创作资产整理"],
        "presets": [
            {"id": "worldbuilding-consistency", "label": {"zh": "设定一致性检查", "en": "Setting consistency"}, "description": {"zh": "核对正文与现有世界规则。", "en": "Compare prose against established world rules."}, "goal": {"zh": "读取当前章节及世界观、角色、物品和地图资料，检查设定冲突、遗漏规则和需要补充说明之处。", "en": "Read the current chapter and world data, then find setting conflicts, missing rules, and areas needing clarification."}},
            {"id": "worldbuilding-expand", "label": {"zh": "补充世界观设定", "en": "Expand worldbuilding"}, "description": {"zh": "根据现有材料生成可审核设定草稿。", "en": "Generate a reviewable setting draft from existing material."}, "goal": {"zh": "读取当前世界观和相关正文，找出最需要补充的设定空缺，并生成可审核的世界观设定草稿。", "en": "Read the current worldbuilding and prose, identify the most important gap, and generate a reviewable setting draft."}, "deliverable": "creative_assets_draft"},
        ],
    },
    {
        "id": "research_rag",
        "agent": "research_rag",
        "label": {"zh": "研究", "en": "Research"},
        "description": {"zh": "检索项目知识和外部资料，整理可追溯证据。", "en": "Retrieve project knowledge and external references with traceable evidence."},
        "tools": ["chapter.get", "rag.ask", "search.query", "plotline.list", "character.list", "item.list", "worldsetting.list", "map.list"],
        "skills": ["资料检索", "证据整理", "事实核对"],
        "presets": [
            {"id": "research-evidence", "label": {"zh": "背景资料整理", "en": "Background research"}, "description": {"zh": "汇总与当前写作任务有关的证据。", "en": "Collect evidence relevant to the current writing task."}, "goal": {"zh": "围绕当前章节主题检索项目知识库和必要的外部资料，按来源整理事实、可用细节和不确定项。", "en": "Research the current chapter topic in project knowledge and external sources, organizing facts, useful details, and uncertainties by source."}},
            {"id": "research-fact-check", "label": {"zh": "事实核对", "en": "Fact check"}, "description": {"zh": "检查正文中的可验证陈述。", "en": "Verify factual claims in the prose."}, "goal": {"zh": "读取当前章节，识别需要核验的现实事实或专业细节，检索证据并逐项给出结论和来源。", "en": "Read the current chapter, identify claims requiring verification, retrieve evidence, and report a conclusion and source for each."}},
        ],
    },
]

_ATTACHMENT_TOOLS = ["attachment.list", "attachment.read", "attachment.outline", "attachment.search", "attachment.get"]
for _role in _ROLE_REGISTRY:
    _role["tools"] = [*_ATTACHMENT_TOOLS, *_role["tools"]]


def _localized(value: Any, language: str) -> Any:
    if isinstance(value, dict) and set(value).issubset({"zh", "en"}):
        return value.get(language) or value.get("zh") or value.get("en") or ""
    if isinstance(value, list):
        return [_localized(item, language) for item in value]
    if isinstance(value, dict):
        return {key: _localized(item, language) for key, item in value.items()}
    return value


def list_agent_roles(locale: str = "zh-CN") -> list[AgentRoleDefinition]:
    language = "en" if locale.lower().startswith("en") else "zh"
    return [AgentRoleDefinition.model_validate(_localized(role, language)) for role in _ROLE_REGISTRY]
