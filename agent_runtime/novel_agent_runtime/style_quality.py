"""Bounded evidence dossiers and independently checked Style Skill acceptance."""
from __future__ import annotations

import asyncio
import sqlite3
from collections import defaultdict
from typing import Any

from .skill_analysis_graph import canonical, fingerprint
from .toolchains.schemas import ToolchainError

FEATURES = {
    "short_actions": "短促动作与判断", "long_reasoning": "长推演与短句收束", "paragraphs": "段落与焦点切换",
    "close_pov": "视角与叙述距离", "dialogue": "对白信息载荷", "character_voice": "人物辨识与说话方式",
    "observable_emotion": "情绪外化与描写取舍", "diction": "词汇与修辞",
    "show_then_explain": "先展示后解释", "hypothesis": "假设检验", "clues": "线索与误导",
    "knowledge_gap": "读者认知差", "chapter_end": "章末收束", "ensemble": "多人物推进", "other": "其他局部特征",
}
CRITERIA = ("task_fit", "rule_calibration", "evidence_trace", "counterexamples", "contamination", "binding_fit")
TRIAL_CRITERIA = ("task_completion", "style_application", "clarity", "non_mechanical", "non_contamination")
FIDELITY_TRIAL_CRITERIA = (*TRIAL_CRITERIA, 'source_fidelity', 'rhythm_variation')
FIDELITY_SCENE = ('原创中性场景：两个人在一家小店归还借来的普通物品，对交还方式有不同看法，需要协商下一步。'
    '不预设精确时间、登记谜题、灯闪、指尖动作或章末悬念。人物可直接表达感受、判断，也可通过行动表达。写250至450字的完整正文。')
FIDELITY_GROUP_SCENE = ('原创中性场景：五人在一次普通搬家中分配收拾、搬运和归还借物的工作，诉求有差异，需要协商下一步。'
    '不要求平均发言或固定切换次数，不预设精确时间、登记谜题、灯闪、指尖动作或章末悬念。写250至450字的完整正文。')
TRANSITION_SCENE = ('原创中性过渡场景：一个人在处理完日常事务后换一个地点，途中处理一件尚未完成的小事。'
    '保留人物当下观察与思考，不强制制造新谜题、反转、微动作或未答收束。按来源适用的叙述方式写250至450字正文。')
TRIAL_SCENE = ("原创中性场景：开放办事大厅里，值班员交接一只普通保管盒，封条完好但登记时间与墙钟不同；"
    "来取件的人出示有效凭证，催促交付却说不出盒子的重量。记录员坚持先核对签名，搬运员关注重量差，等候者担心拿错自己的物品。"
    "五人在同一事件中有不同诉求，值班员需要决定是否交付；不要求每个人平均发言或固定次数串联。"
    "不添加来源作品的专名、游戏规则、组织或情节；不要求固定句长或章末模板。写一段250至450字的完整场景正文。")


def evidence_pages(units: list[tuple[str, dict[str, Any]]], maximum: int) -> list[list[dict[str, Any]]]:
    candidates = []
    for ref, result in units:
        for index, finding in enumerate(result.get("findings", [])):
            candidates.append({"findingRef": f"{ref}:{index}", **finding})
        if not result.get("findings"):
            candidates.append({"findingRef": f"{ref}:summary", "dimension": "unverified", "observation": result["summary"],
                "confidence": "low", "evidence": []})
    pages, pending = [], []
    for candidate in candidates:
        if len(pending) == 16 or len(canonical({"features": FEATURES, "candidates": [*pending, candidate]}).encode()) + 2500 > maximum:
            if pending:
                pages.append(pending)
                pending = []
        if len(canonical({"features": FEATURES, "candidates": [candidate]}).encode()) + 2500 > maximum:
            raise ToolchainError("BUDGET_EXCEEDED", "文风专家窗口无法容纳一个完整候选；已保存分析保留。")
        pending.append(candidate)
    if pending:
        pages.append(pending)
    return pages


def validate_quality(value: Any, phase: str, source: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("phase") != phase:
        raise ToolchainError("MODEL_OUTPUT_INVALID", "文风验收返回的阶段不匹配。")
    if phase == "evidence":
        expected = {item["findingRef"]: item for item in source["candidates"]}
        decisions = value.get("decisions", [])
        if (not isinstance(decisions, list) or len(decisions) != len(expected)
                or {item.get("findingRef") for item in decisions if isinstance(item, dict)} != set(expected)):
            raise ToolchainError("MODEL_OUTPUT_INVALID", "文风专家未逐项核对本页候选，不能声明审核完成。")
        for index, item in enumerate(decisions):
            if (item.get("feature") not in FEATURES or item.get("disposition") not in {"supported", "counterexample", "unresolved"}
                    or not str(item.get("reason", "")).strip() or len(str(item["reason"])) > 300):
                raise ToolchainError("MODEL_OUTPUT_INVALID", "文风候选分类或理由无效。")
            original = expected[item["findingRef"]]
            if item["disposition"] != "unresolved" and (not original.get("evidence") or original.get("evidenceIncomplete")):
                item = dict(item)
                item["disposition"] = "unresolved"
                decisions[index] = item
        return {"phase": phase, "decisions": decisions}
    if phase == "generate_trial":
        text = value.get("text")
        if not isinstance(text, str) or not 200 <= len(text.strip()) <= 1200 or text.lstrip().startswith(("---", "```")):
            raise ToolchainError("MODEL_OUTPUT_INVALID", "试写未返回有界的完整场景正文。")
        for quote in source.get("sourceQuotes", []):
            if len(quote) >= 20 and quote in text:
                raise ToolchainError("MODEL_OUTPUT_INVALID", "试写复用了来源长句，不能通过验收。")
        return {"phase": phase, "text": text.strip()}
    required = CRITERIA if phase == "document" else (FIDELITY_TRIAL_CRITERIA if source.get('fidelityMode') == 2 else TRIAL_CRITERIA)
    checks = value.get("checks")
    issues = value.get("issues", [])
    if (not isinstance(checks, dict) or set(checks) != set(required)
            or any(status not in {"pass", "fail", "unverified"} for status in checks.values())
            or not isinstance(issues, list) or len(issues) > 12
            or not str(value.get("summary", "")).strip()):
        raise ToolchainError("MODEL_OUTPUT_INVALID", "文风验收缺少完整质量检查项。")
    for issue in issues:
        if (not isinstance(issue, dict) or not str(issue.get("message", "")).strip()
                or issue.get("severity", "blocking") not in {"blocking", "advisory"}):
            raise ToolchainError("MODEL_OUTPUT_INVALID", "文风验收诊断没有具体问题。")
    accepted = all(status == "pass" for status in checks.values()) and not any(i.get("severity", "blocking") == "blocking" for i in issues)
    return {"phase": phase, "accepted": accepted, "checks": checks, "issues": issues,
            "summary": str(value["summary"])[:1000]}


def build_dossier(pages: list[list[dict[str, Any]]], reviews: list[dict[str, Any]], coverage: dict[str, Any]) -> dict[str, Any]:
    candidates = {item["findingRef"]: item for page in pages for item in page}
    groups = defaultdict(lambda: {"supported": [], "counterexample": [], "unresolved": []})
    for review in reviews:
        for decision in review["decisions"]:
            groups[decision["feature"]][decision["disposition"]].append(decision)
    features = []
    for key, group in groups.items():
        feature = {"feature": key, "label": FEATURES[key]}
        for disposition, decisions in group.items():
            sources = {e["sourceId"] for d in decisions for e in candidates[d["findingRef"]].get("evidence", [])}
            feature[disposition + "ChapterCount"] = len(sources)
            feature[disposition + "FindingCount"] = len(decisions)
            examples, selected = [], set()
            for d in decisions:
                finding = candidates[d["findingRef"]]
                evidence = finding.get("evidence", [])
                chapter = evidence[0]["sourceId"] if evidence else ""
                if chapter in selected:
                    continue
                selected.add(chapter)
                short_evidence = [{**evidence[0], "excerpt": evidence[0]["excerpt"][:100],
                    "endOffset": evidence[0].get("startOffset", 0) + len(evidence[0]["excerpt"][:100])}] if evidence else []
                examples.append({"findingRef": d["findingRef"], "observation": finding["observation"][:120],
                    "reason": d["reason"][:100], "evidence": short_evidence,
                    "boundedExample": True})
                if len(examples) == 1:
                    break
            feature[disposition + "Examples"] = examples
        features.append(feature)
    return {"version": 1, "coverage": coverage, "reviewedCandidateCount": len(candidates),
        "pageCount": len(pages), "features": features,
        "limitations": ["支持章数表示已保存观察涉及的独立章节，不是原文句子占比；未提及不代表不存在。",
            "代表引文不是全部样本；完整候选及专家判断保存在工作单元引用。",
            "跨章兑现、人物弧线和句长分布没有因此自动完成验证；不生成无统计依据的硬阈值。"]}


def quality_key(run, phase: str, source: dict[str, Any]) -> str:
    owner = f"{run.retryRootRunId or run.retryOfRunId or run.runId}:{run.currentStepId}"
    return fingerprint([owner, "style-quality-v1", phase, source, [s.model_dump() for s in run.skillSnapshot]])


def document_quality_input(document, member_plan, dossier, bindings) -> dict[str, Any]:
    return {"document": document, "memberPlan": member_plan, "reviewedEvidence": dossier, "bindings": bindings,
        "metadataContract": {"managed": True, "outputTypeNone": "不覆盖调用任务产物类型；写作模式仍输出正文。",
            "evidenceTrace": "完整统计与findingRef由reviewedEvidence及持久化日志提供，正文应准确说明方法适用边界。"}}


def document_review_source(source: dict[str, Any]) -> dict[str, Any]:
    """Keep the full document and all statistics; scope representative examples.

    Evidence classification already covered every candidate. This projection
    never treats a missing example as absence and includes cross-dimension
    examples explicitly referenced by the document or its plan.
    """
    dossier = source["reviewedEvidence"]
    member = source["memberPlan"]["draftKey"]
    relevant = {
        "language_style": set(list(FEATURES)[:8]),
        "suspense_release": set(list(FEATURES)[8:13]),
        "ensemble_progression": {"ensemble"},
    }.get(member, set(FEATURES)) | {"other"}
    text = source["document"]["contentText"] + canonical(source["memberPlan"])
    features, omitted = [], []
    for feature in dossier["features"]:
        examples = [example for stance in ("supported", "counterexample", "unresolved")
                    for example in feature.get(stance + "Examples", [])]
        referenced = feature["feature"] in text or feature.get("label", FEATURES[feature["feature"]]) in text
        referenced = referenced or any(example.get("findingRef", "") in text for example in examples if example.get("findingRef"))
        referenced = referenced or any(len(e.get("excerpt", "")) >= 12 and e["excerpt"] in text
                                      for example in examples for e in example.get("evidence", []))
        if feature["feature"] in relevant or referenced:
            features.append(feature)
        else:
            # All counts, including counterexamples and unresolved findings,
            # remain available for calibration of cross-dimension assertions.
            features.append({key: value for key, value in feature.items() if not key.endswith("Examples")})
            omitted.append(feature["feature"])
    return {**source, "reviewedEvidence": {**dossier, "features": features,
        "projection": {"version": 1, "dossierRef": fingerprint(dossier), "member": member,
            "omittedExampleFeatures": omitted,
            "scope": "全部候选已逐项审核，所有维度统计完整保留；代表例证包含当前成员维度及正文/规划显式引用的其他维度。其余维度只省略代表例证，不表示不存在或没有反例；完整记录仍在持久化证据日志。"}}}


async def review_evidence_page(runtime, run, source: dict[str, Any], policy: dict[str, Any], progress=None) -> dict[str, Any]:
    """Reuse old 16-item successes; new calls cover <=8 items, then halve on confirmed truncation.

    Logical pages and finding identities stay stable across recovery. Unknown
    requests must be reconciled before any subdivision can issue a new call.
    Each child uses the same journal, owner, execution policy and total budget.
    """
    if run.cancelRequested:
        raise ToolchainError("CANCELLED", "文风验收已取消。")
    engine = await runtime.skill_execution_engine.get_graph()
    key = quality_key(run, "evidence", source)
    cached = await asyncio.to_thread(engine.store.result, key)
    if cached is not None:
        return validate_quality(cached, "evidence", source)
    record = await asyncio.to_thread(engine.store.record, key)
    candidates = source["candidates"]
    truncated = bool(record and record["status"] == "failed" and
        (record.get("error") or {}).get("code") == "MODEL_OUTPUT_TRUNCATED")
    retry_terminal_leaf = truncated and len(candidates) == 1 and run.retryOfRunId
    if (not truncated or retry_terminal_leaf) and (len(candidates) <= 8 or (record and (record["status"] == "running" or record["rawResult"] is not None))):
        try:
            return await quality_request(runtime, run, "evidence", source, policy)
        except Exception as error:
            if getattr(error, "code", None) != "MODEL_OUTPUT_TRUNCATED":
                raise
    if len(candidates) <= 1:
        raise ToolchainError("MODEL_OUTPUT_TRUNCATED",
            "单个文风候选审核仍达到模型输出上限。已完成结果保留，请调整模型或输出预算后从检查点继续。")
    midpoint = len(candidates) // 2
    if progress:
        await progress(f"将 {len(candidates)} 个候选分成 {midpoint} 和 {len(candidates) - midpoint} 个分别审核；已完成结果复用")
    decisions = []
    for part in (candidates[:midpoint], candidates[midpoint:]):
        review = await review_evidence_page(runtime, run, {**source, "candidates": part}, policy, progress)
        decisions.extend(review["decisions"])
    return validate_quality({"phase": "evidence", "decisions": decisions}, "evidence", source)


async def quality_request(runtime, run, phase: str, source: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    if run.cancelRequested:
        raise ToolchainError("CANCELLED", "文风验收已取消。")
    if (run.resumedFrom or {}).get("mode") == "retry_unconfirmed_units" and not run.resumedFrom.get("unconfirmedReconciled"):
        await runtime._reconcile_unconfirmed_analysis_requests(run)
        run.resumedFrom["unconfirmedReconciled"] = True
        runtime._save()
    engine = await runtime.skill_execution_engine.get_graph()
    owner = f"{run.retryRootRunId or run.retryOfRunId or run.runId}:{run.currentStepId}"
    stage = policy.get("stages", {}).get("expert", {})
    maximum = stage.get("maxInputBytes", policy["maxInputBytes"])

    async def saved(material):
        key = quality_key(run, phase, material)
        result = await asyncio.to_thread(engine.store.result, key)
        record = await asyncio.to_thread(engine.store.record, key) if result is None else None
        raw = record.get("rawResult") if record else None
        if raw is not None and record["status"] == "failed" and run.retryOfRunId:
            try:
                validate_quality(raw, phase, material)
            except ToolchainError:
                raw = None
        if raw is None and record and record["status"] == "running":
            raw = await runtime._recover_skill_model("agent.style_quality", record["requestId"])
        return key, result, record, raw

    # Reuse successful legacy requests and reconcile unknown requests before
    # changing their material/key. Neither path sends a fresh provider request.
    key, result, record, raw = await saved(source)
    if result is not None:
        return result
    if raw is None and len(canonical(source).encode()) + 1024 > maximum:
        if phase == "document":
            source = document_review_source(source)
            key, result, record, raw = await saved(source)
            if result is not None:
                return result
        required = len(canonical(source).encode()) + 1024
        if raw is None and required > maximum:
            raise ToolchainError("STYLE_QUALITY_INPUT_LIMIT",
                f"文风验收材料超过本阶段输入预算（需要 {required} 字节，预算 {maximum} 字节）。已保存结果保留；请调整审核输入预算或文档后继续，没有截断待审核正文。",
                details={"phase": phase, "requiredInputBytes": required, "maxInputBytes": maximum,
                    "projectionVersion": 1 if phase == "document" else 0})
    if raw is None:
        await asyncio.to_thread(engine.store.begin, owner, key, fingerprint(source),
            stage.get("inputReserveTokens", len(canonical(source).encode())) + stage.get("outputReserveTokens", policy["outputReserveTokens"]),
            policy, stage.get("maxProviderCalls", 1))
        record = await asyncio.to_thread(engine.store.record, key)
    try:
        if raw is None:
            raw = await runtime._invoke_skill_model(run, "agent.style_quality", {"phase": phase, "source": source,
                "locale": "zh-CN", "executionBudget": stage}, record["requestId"], key)
            await asyncio.to_thread(engine.store.save_raw, key, raw)
        result = validate_quality(raw, phase, source)
        await asyncio.to_thread(engine.store.finish, key, result,
            {"kind": "style_quality", "phase": phase, "executionUsage": raw.get("_executionUsage")})
        return result
    except Exception as error:
        if not isinstance(error, (sqlite3.Error, OSError)):
            await asyncio.to_thread(engine.store.fail, key, error)
        raise


async def advance_quality(runtime, run, plan, step, graph_state, chain: dict[str, Any]) -> dict[str, Any]:
    from .agent_skills.authoring import STYLE_SKILL_MEMBER_PATHS
    from .toolchains.schemas import StyleSkillPackAuthoringPlan

    stage = chain["stage"]
    analyzed = chain.get("styleAnalysisResult")
    if not isinstance(analyzed, dict) or not analyzed.get("unitRefs"):
        raise ToolchainError("CONTEXT_INSUFFICIENT", "文风质量验收缺少完整分析引用；请从获准来源分析检查点继续。")
    policy = analyzed["executionPolicy"]
    engine = await runtime.skill_execution_engine.get_graph()

    def transition(**updates):
        return {"toolchain_state": {**chain, **updates}, "action": "continue", "resume_response": None}

    async def notify(node, message, status="running"):
        await runtime._emit(run, "toolchain_node_started" if status == "running" else "toolchain_node_completed",
            step_id=step.stepId, agent="editor", status=status,
            payload={"toolchainId": step.toolchain.id, "nodeId": node, "summary": message, "kind": "model"})

    if stage == "evidence_review":
        from .toolchains.schemas import AgentChapterSnapshot
        await runtime._validate_skill_sources(run, {"novelId": graph_state["novel_id"],
            "chapterIds": [s["chapterId"] for s in analyzed["sourceSnapshot"]]},
            [AgentChapterSnapshot.model_validate(s) for s in analyzed["sourceSnapshot"]])
        units = []
        for ref in analyzed["unitRefs"]:
            result = await asyncio.to_thread(engine.store.result, ref)
            if result is None:
                raise ToolchainError("CONTEXT_INSUFFICIENT", "文风候选日志缺失，不能以根摘要代替完整证据。")
            units.append((ref, result))
        pages = evidence_pages(units, policy.get("stages", {}).get("expert", {}).get("maxInputBytes", policy["maxInputBytes"]))
        coverage = {key: value for key, value in analyzed["coverage"].items() if key != "omittedChapterIds"}
        from .style_fidelity import fidelity_enabled, split_profiles, authoring_evidence, ensure_profiles
        public_profile, validation_profile = {}, {}
        if fidelity_enabled(step.skills):
            async def read_profile(snapshot):
                from .toolchains.schemas import ChapterScopeBundle
                raw = await runtime._tool_invoke(run, 'chapter.scope_context.build', {
                    'novelId': graph_state['novel_id'], 'kind': 'current_chapter', 'chapterId': snapshot['chapterId'],
                    'anchorChapterId': snapshot['chapterId'], 'goal': plan.goal, 'locale': graph_state['locale'],
                    'representation': 'verbatim', 'processingMode': 'detailed',
                    'currentContent': graph_state['current_content'] if snapshot['chapterId'] == graph_state['chapter_id'] else '',
                })
                bundle = ChapterScopeBundle.model_validate(raw)
                match = next((c for c in bundle.chapters if c.chapterId == snapshot['chapterId']), None)
                return match.model_dump() if match else None
            profiles = await ensure_profiles(runtime.skill_execution_engine.state_dir, analyzed['sourceSnapshot'], read_profile)
            public_profile, validation_profile = split_profiles(profiles)
        reviews = []
        for index, page in enumerate(pages):
            await notify(f"style_evidence.{index + 1}", f"文风专家逐项核对 {index + 1}/{len(pages)} 页")
            async def subdivision(message):
                await notify(f"style_evidence.{index + 1}", message)
            review = await review_evidence_page(runtime, run, {"features": FEATURES, "candidates": page,
                "coverage": coverage}, policy, subdivision)
            reviews.append(review)
            await notify(f"style_evidence.{index + 1}", f"已核对第 {index + 1} 页的 {len(page)} 个候选", "completed")
        learning_pages, learning_reviews = pages, reviews
        if fidelity_enabled(step.skills):
            learning_pages, learning_reviews = authoring_evidence(pages, reviews, set(public_profile['validationChapterIds']))
        dossier = build_dossier(learning_pages, learning_reviews, coverage)
        source = {**chain["source"], "reviewedEvidence": dossier,
            **({'styleProfile': public_profile, 'fidelityMode': 2} if public_profile else {}),
            "analysis": {"summary": f"已分析 {analyzed['chapterCount']} 章，专家逐项核对 {dossier['reviewedCandidateCount']} 个候选；支持分布见 reviewedEvidence。", "findings": []}}
        return transition(stage="plan", source=source, styleFidelityValidation=validation_profile, styleEvidenceAudit={"dossierRef": fingerprint(dossier),
            "candidateCount": dossier["reviewedCandidateCount"], "pageCount": len(pages), "coverage": analyzed["coverage"]})

    workspace = await runtime._automation_invoke(run, "agent_skill.workspace.list", {"draftId": chain["skillWorkspace"]["draftId"]},
        node_id="style_quality.workspace")
    style_plan = StyleSkillPackAuthoringPlan.model_validate(chain["stylePlan"])
    documents = []
    for member in style_plan.skills:
        path = STYLE_SKILL_MEMBER_PATHS[member.draftKey]
        document = await runtime._automation_invoke(run, "agent_skill.workspace.read", {"draftId": workspace["draftId"], "logicalPath": path},
            node_id=f"style_quality.read.{member.draftKey}")
        text = str(document.get("contentText") or "")
        if document.get("version") is not None and document["version"] != workspace["version"]:
            raise ToolchainError("INPUT_INVALID", "文风成员在审核读取期间被修改，请核对草稿版本后再继续。")
        if not text:
            raise ToolchainError("INPUT_INVALID", "文风成员正文缺失，不能验收。")
        documents.append({"draftKey": member.draftKey, "logicalPath": path, "contentText": text, "contentHash": fingerprint(text)})
    input_hash = workspace.get("authoringInputHash") or fingerprint([documents, style_plan.pack.model_dump()])
    dossier = chain["source"]["reviewedEvidence"]

    def repair_or_stop(diagnostics, report):
        attempt = int(chain.get("styleQualityAttempt", 0)) + 1
        if attempt >= 3:
            raise ToolchainError("STYLE_SKILL_WORKSPACE_NEEDS_ATTENTION", "文风草稿未通过内容审核或试写，已保存成员正文和诊断；未编译为可启用产物。",
                details={"skillDraftId": workspace["draftId"], "qualityReview": report})
        keys = [m.draftKey for m in style_plan.skills if STYLE_SKILL_MEMBER_PATHS[m.draftKey] in diagnostics]
        return transition(stage="repair", skillWorkspace=workspace, styleQualityAttempt=attempt,
            styleDiagnostics=diagnostics, styleRepairKeys=keys, styleRepairIndex=0, styleQualityReview=None, styleValidationAttempt=0)

    if stage == "quality_review":
        reviews, diagnostics = [], {}
        for document, member in zip(documents, style_plan.skills):
            await notify(f"style_quality.{member.draftKey}", f"专家审核成员正文：{member.title}")
            source = document_quality_input(document, member.model_dump(), dossier, style_plan.pack.model_dump())
            if chain['source'].get('fidelityMode') == 2:
                source.update({'fidelityMode': 2, 'styleProfile': chain['source'].get('styleProfile', {})})
            review = await quality_request(runtime, run, "document", source, policy)
            reviews.append({"draftKey": member.draftKey, "contentHash": document["contentHash"], **review})
            await notify(f"style_quality.{member.draftKey}", review["summary"], "completed")
            if not review["accepted"]:
                messages = [issue["message"] for issue in review["issues"] if issue.get("severity", "blocking") == "blocking"] or ["未通过检查项：" + ",".join(k for k, v in review["checks"].items() if v != "pass")]
                diagnostics[document["logicalPath"]] = [{"code": "STYLE_CONTENT_REVIEW", "path": document["logicalPath"],
                    "severity": "error", "message": message} for message in messages]
        if diagnostics:
            return repair_or_stop(diagnostics, reviews)
        return transition(stage="trial", skillWorkspace=workspace, styleDocumentReviews=reviews, styleReviewedInputHash=input_hash)

    if chain.get("styleReviewedInputHash") != input_hash:
        return transition(stage="quality_review", skillWorkspace=workspace)
    variants = {"baseline": [], **{d["draftKey"]: [d] for d in documents}}
    writer_bindings = [b for b in style_plan.pack.bindings if b.roleId == "writer" and b.operationId in
        {"chapter.create", "chapter.continuation", "chapter.rewrite", "chapter.sequence_continuation", "chapter.batch_rewrite"}]
    if not writer_bindings:
        raise ToolchainError("INPUT_INVALID", "文风 Pack 缺少真实 writer 写作绑定，不能进行应用验收。")
    binding = writer_bindings[0]
    variants["pack"] = [d for d in documents if d["draftKey"] in {binding.primaryDraftKey, binding.auxiliaryDraftKey}]
    combinations = {}
    if chain.get('stylePackRouting'):
        from .agent_skills.pack_routing import writing_combinations
        for (primary, auxiliary), operation in writing_combinations(style_plan, chain['stylePackRouting']).items():
            members = [d for d in documents if d['draftKey'] in {primary, auxiliary}]
            existing = next((key for key, value in variants.items() if value == members), None)
            key = existing or f'pack_{primary}_{auxiliary or "none"}'
            variants[key] = members
            combinations[key] = {'primaryDraftKey': primary, 'auxiliaryDraftKey': auxiliary, 'operationId': operation, 'roleId': 'writer'}
    fidelity = chain['source'].get('fidelityMode') == 2
    interaction_scene = FIDELITY_GROUP_SCENE if any(d['draftKey'] == 'ensemble_progression' for d in documents) else FIDELITY_SCENE
    if fidelity:
        variants = {**variants, **{'transition.' + key: value for key, value in variants.items()}}
    trials = {}
    quotes = []
    for ref in analyzed["unitRefs"]:
        leaf = await asyncio.to_thread(engine.store.result, ref)
        if not leaf:
            raise ToolchainError("CONTEXT_INSUFFICIENT", "原分析引用缺失，无法检查试写污染。")
        quotes.extend(e["excerpt"] for finding in leaf.get("findings", []) for e in finding.get("evidence", []))
    for key, members in variants.items():
        await notify(f"style_trial.{key}", f"原创场景试写：{key}")
        scene = TRANSITION_SCENE if key.startswith('transition.') else interaction_scene if fidelity else TRIAL_SCENE
        result = await quality_request(runtime, run, "generate_trial", {"scene": scene,
            "documents": members, "operationId": combinations.get(key, {}).get('operationId', binding.operationId), "roleId": "writer"}, policy)
        validate_quality(result, "generate_trial", {"sourceQuotes": quotes})
        trials[key] = result["text"]
        await notify(f"style_trial.{key}", "试写正文已保存，等待对照审核", "completed")
    reviews, diagnostics = {}, {}
    for key in variants:
        if key == "baseline" or key == 'transition.baseline':
            continue
        member_key = key.removeprefix('transition.')
        baseline_key = 'transition.baseline' if key.startswith('transition.') else 'baseline'
        if trials[key] == trials[baseline_key] and not (key.startswith('transition.') and member_key in {'suspense_release', 'ensemble_progression'}):
            for document in variants[key]:
                diagnostics.setdefault(document["logicalPath"], []).append({"code": "STYLE_TRIAL_NO_EFFECT", "severity": "error",
                    "path": document["logicalPath"], "message": "应用成员后的试写与基线完全相同，不能声明文风应用已通过。"})
            continue
        swapped = int(fingerprint([input_hash, key])[:2], 16) % 2 == 0
        await notify(f"style_trial.review.{key}", f"独立对照审核：{key}")
        features = dossier["features"]
        if member_key == "language_style":
            features = [item for item in features if item["feature"] in list(FEATURES)[:8]]
        elif member_key == "suspense_release":
            features = [item for item in features if item["feature"] in list(FEATURES)[8:13]]
        elif member_key == "ensemble_progression":
            features = [item for item in features if item["feature"] == "ensemble"]
        scene = TRANSITION_SCENE if key.startswith('transition.') else interaction_scene if fidelity else TRIAL_SCENE
        review = await quality_request(runtime, run, "trial", {"scene": scene, "A": trials[key] if swapped else trials[baseline_key],
            "B": trials[baseline_key] if swapped else trials[key], "target": "A" if swapped else "B",
            **({'fidelityMode': 2, 'referenceProfile': chain.get('styleFidelityValidation', {}),
                'styleProfile': chain['source'].get('styleProfile', {}), 'member': member_key} if fidelity else {}),
            "reviewedEvidence": {**dossier, "features": features}}, policy)
        reviews[key] = review
        await notify(f"style_trial.review.{key}", review["summary"], "completed")
        if not review["accepted"]:
            affected = variants[key]
            for document in affected:
                diagnostics.setdefault(document["logicalPath"], []).append({"code": "STYLE_APPLICATION_TRIAL", "severity": "error",
                    "path": document["logicalPath"], "message": review["summary"] + "；" + ";".join(i["message"] for i in review["issues"])})
    if diagnostics:
        return repair_or_stop(diagnostics, {"trials": trials, "reviews": reviews})
    return transition(stage="compile", skillWorkspace=workspace, styleQualityReview={"version": 2 if fidelity else 1,
        "status": "passed", "inputHash": input_hash, "evidenceAudit": chain["styleEvidenceAudit"],
        "documentReviews": chain["styleDocumentReviews"], "trials": trials, "trialReviews": reviews,
        **({'sceneKeys': ['interaction', 'transition'], 'referenceProfileHash': fingerprint(chain.get('styleFidelityValidation', {})),
            'sourceProfile': chain['source'].get('styleProfile', {})} if fidelity else {}),
        **({'verifiedCombinations': [{**pair, 'accepted': reviews[key]['accepted'], 'trialKey': key} for key, pair in combinations.items()]}
           if combinations else {}),
        "limitation": ('两个原创场景的来源对照审核通过；' + chain.get('styleFidelityValidation', {}).get('limitation', '')
            + '不代表已验证所有场景或完整还原来源小说。') if fidelity else "原创中性场景的模型对照审核通过；不代表已验证所有场景或完整还原来源小说。"})
