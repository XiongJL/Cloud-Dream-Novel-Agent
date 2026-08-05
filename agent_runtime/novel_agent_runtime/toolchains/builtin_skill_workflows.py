from __future__ import annotations

from typing import Any

from .schemas import NovelBootstrapDraft, StyleSkillPackDraftArtifact


def novel_bootstrap_markdown(draft: NovelBootstrapDraft) -> str:
    lines = [
        "# 新小说方案",
        "",
        "## 书名候选",
        *[f"- {item}" for item in draft.titleCandidates],
        "",
        "## 题材与读者承诺",
        "",
        f"- 题材承诺：{draft.genrePromise}",
        f"- 读者承诺：{draft.readerPromise}",
        f"- 核心前提：{draft.corePremise}",
        f"- 核心问题：{draft.centralQuestion}",
        f"- 叙事形态：{draft.narrativeShape}",
        "",
        "## 核心人物",
        "",
    ]
    for item in draft.characters:
        lines.extend([
            f"### {item.name} · {item.role}",
            f"- 欲望：{item.desire}",
            f"- 代价：{item.cost}",
            f"- 变化：{item.change}",
            "",
        ])
    lines.extend(["## 世界规则", "", *[f"- {item}" for item in draft.worldRules]])
    lines.extend(["", "## 冲突升级", "", *[f"{index + 1}. {item}" for index, item in enumerate(draft.conflictEscalation)]])
    lines.extend(["", "## 悬念与信息释放", "", *[f"- {item}" for item in draft.suspenseStrategy]])
    lines.extend(["", "## 开篇章节节拍", "", *[f"{index + 1}. {item}" for index, item in enumerate(draft.openingBeats)]])
    lines.extend(["", "## 分卷路线", ""])
    for item in draft.volumePlan:
        lines.extend([
            f"### {item.title}（{item.chapterRange}）",
            f"- 核心问题：{item.dramaticQuestion}",
            f"- 关键转折：{item.turningPoint}",
            "",
        ])
    lines.extend(["## 连载章节表", ""])
    for item in draft.chapterPlan:
        lines.extend([
            f"### 第 {item.chapterNumber} 章：{item.title}",
            f"- 场景目标：{item.sceneGoal}",
            f"- 核心冲突：{item.conflict}",
            f"- 章末钩子：{item.hook}",
            "",
        ])
    lines.extend([
        "## 连载执行设置",
        "",
        f"- 建议模式：{draft.writingModeRecommendation}",
        f"- 目标章节数：{draft.targetChapterCount}",
        f"- 单章目标字数：{draft.targetWordsPerChapter}",
        "",
        "## 质量校验",
        "",
        *[f"- {item}" for item in draft.validationChecklist],
    ])
    lines.extend(["", "## 已确认方向", "", draft.userDecisionSummary])
    if draft.assumptions:
        lines.extend(["", "## 待确认假设", "", *[f"- {item}" for item in draft.assumptions]])
    if draft.warnings:
        lines.extend(["", "## 风险提示", "", *[f"- {item}" for item in draft.warnings]])
    return "\n".join(lines).strip()


def novel_project_initialization_brief(draft: NovelBootstrapDraft) -> str:
    """Translate the approved blueprint into the creative-assets tool's source brief."""
    payload = draft.model_dump()
    return "\n".join([
        "基于以下已确认的小说项目蓝图，生成首轮可审核的项目素材草稿。",
        "必须把故事线、情节点、角色、物品、技能、世界设定和地图/地点映射为产品原生字段；"
        "只生成蓝图明确支持的内容，不要把假设写成既定事实。",
        "情节点应归属对应情节线；角色、物品和技能要服务于核心冲突与前期开篇；"
        "世界设定与地图/地点只保留对首卷或开篇有明确作用的项目。",
        "不要生成章节正文，也不要直接写入项目。",
        "",
        "已确认蓝图 JSON：",
        __import__("json").dumps(payload, ensure_ascii=False, separators=(",", ":")),
    ])


def style_skill_pack_markdown(draft: StyleSkillPackDraftArtifact) -> str:
    lines = [
        "# 文风 Skill Pack 草稿",
        "",
        draft.summary,
        "",
        "## 来源覆盖",
        "",
        "```json",
        __import__("json").dumps(draft.sourceCoverage, ensure_ascii=False, indent=2),
        "```",
    ]
    for item in draft.skills:
        lines.extend([
            "",
            f"## {item.title}",
            "",
            f"- Draft Key：`{item.draftKey}`",
            f"- Stable ID 候选：`{item.stableIdCandidate}`",
            f"- 指导自由度：`{item.guidanceMode}`",
            f"- 置信度：`{item.confidence}`",
            f"- 用途：{item.description}",
            "",
            "### 正向触发",
            *[f"- {hint}" for hint in item.triggerHints],
            "",
            "### 反向触发",
            *[f"- {hint}" for hint in item.antiTriggerHints],
            "",
            "### 方法",
            "",
            item.instructions,
            "",
            "### 约束",
            *[f"- {constraint}" for constraint in item.constraints],
            "",
            f"### 独立试运行\n\n{item.evaluationPrompt}",
        ])
        if item.evidenceNotes:
            lines.extend(["", "### 证据说明", *[f"- {note}" for note in item.evidenceNotes]])
        if item.contaminationWarnings:
            lines.extend(["", "### 污染警告", *[f"- {warning}" for warning in item.contaminationWarnings]])
    lines.extend([
        "",
        f"## Skill Pack：{draft.pack.title}",
        "",
        draft.pack.description,
        "",
    ])
    for binding in draft.pack.bindings:
        auxiliary = f" + {binding.auxiliaryDraftKey}" if binding.auxiliaryDraftKey else ""
        lines.append(f"- `{binding.operationId}` / `{binding.roleId}` → {binding.primaryDraftKey}{auxiliary}")
    if draft.omittedDimensions:
        lines.extend(["", "## 未生成维度", *[f"- {item}" for item in draft.omittedDimensions]])
    if draft.warnings:
        lines.extend(["", "## 风险提示", *[f"- {item}" for item in draft.warnings]])
    return "\n".join(lines).strip()


def workflow_request(
    *,
    goal: str,
    locale: str,
    user_decisions: dict[str, Any] | None,
    source: dict[str, Any] | None,
    agent_skill: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "goal": goal,
        "locale": locale,
        "userDecisions": user_decisions or {},
        "source": source or {},
        "agentSkill": agent_skill or {},
    }
