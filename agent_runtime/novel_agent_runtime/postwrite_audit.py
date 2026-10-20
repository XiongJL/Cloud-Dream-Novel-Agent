"""Evidence-gated, one-pass draft audit. No chapter or canon writes.

The caller supplies the existing review/rewrite model adapter and persists the
returned draft with its ordinary draft service. A successful call is not adoption.
Offsets are Python Unicode code points in the exact source string, not UTF-16.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Awaitable, Callable


class FileDraftAuditJournal:
    """Optional local artifact checkpoint adapter, never a canon/state database.

    Use one new directory per invocation. Existing attempts require inspection;
    creating another journal cannot silently resume or resend model requests.
    """
    def __init__(self, directory: Any):
        from pathlib import Path
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        if (self.directory / 'source.json').exists():
            raise FileExistsError('existing_draft_audit_inspect_before_resume')

    def __call__(self, stage: str, value: Any) -> None:
        import json
        import os
        if stage not in {'source', 'program-checks', 'supplied-candidates', 'audit-raw', 'audit', 'patch-proposal', 'patch-rejected', 'revision', 'recheck-raw', 'recheck', 'result'}:
            raise ValueError('unknown_checkpoint_stage')
        target = self.directory / (stage + '.json')
        temporary = self.directory / (stage + '.json.pending')
        if target.exists():
            raise FileExistsError('checkpoint_already_exists')
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class DraftSource:
    text: str
    draft_id: str
    version: str
    branch: str

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not all(isinstance(v, str) and v.strip() for v in (self.draft_id, self.version, self.branch)):
            raise ValueError('explicit_draft_identity_required')

    def binding(self) -> dict[str, str]:
        return {'draftId': self.draft_id, 'version': self.version, 'branch': self.branch, 'sha256': sha256(self.text)}


def quote_errors(source: DraftSource, evidence: Any) -> list[str]:
    if not isinstance(evidence, list) or not evidence:
        return ['missing_evidence']
    errors = []
    for item in evidence:
        if not isinstance(item, dict):
            errors.append('invalid_evidence'); continue
        quote, start = item.get('quote'), item.get('start')
        if not isinstance(quote, str) or not quote or source.text.count(quote) != 1:
            errors.append('quote_not_unique_exact'); continue
        # Model need not count offsets: resolve only a unique exact quotation.
        if start is not None and (type(start) is not int or start < 0 or source.text[start:start + len(quote)] != quote):
            errors.append('offset_mismatch')
    return errors


def literal_caption_count_proof(source: DraftSource, finding: dict[str, Any]) -> dict[str, Any] | None:
    """Narrow layout proof: explicit caption count followed by its whole line.

    Counts glyphs, not the truth of a letter/record. An arbitrary substring or a
    character's report cannot authorize this exception to the narrator-only gate.
    """
    import re
    if finding.get('statementKind') != 'narrator_assertion' or quote_errors(source, finding.get('evidence')) or quote_errors(source, finding.get('basisEvidence')):
        return None
    numbers = {c: n for n, c in enumerate('零一二三四五六七八九十')}
    pattern = r'正面写了(?P<count>[一二三四五六七八九十0-9]{1,2})个字[^。\n]{0,70}：\n\s*\n(?P<literal>[^\n]{1,60})\n'
    for match in re.finditer(pattern, source.text):
        prefix = source.text[source.text.rfind('\n', 0, match.start()) + 1:match.start()]
        if any(c in prefix for c in '“「『"'):
            continue
        count_text = match['count']
        declared = int(count_text) if count_text.isascii() and count_text.isdigit() else numbers.get(count_text)
        literal = match['literal'].strip(' \t“”「」『』。.!！?？')
        if not literal or not re.fullmatch(r'[\u4e00-\u9fff]+', literal):
            continue
        actual = len(literal)
        if declared is None or not 1 <= actual <= 10 or declared == actual:
            continue
        a, b = match.span('count')
        target = any(source.text.index(e['quote']) <= a and b <= source.text.index(e['quote']) + len(e['quote']) for e in finding['evidence'])
        basis = any(e['quote'].strip(' \t“”「」『』。.!！?？') == literal and
                    match.start('literal') <= source.text.index(e['quote']) and
                    source.text.index(e['quote']) + len(e['quote']) <= match.end('literal') for e in finding['basisEvidence'])
        if target and basis:
            return {'source': source.binding(), 'countSpan': [a, b], 'declared': declared,
                    'literal': literal, 'actual': actual,
                    'requiredReplacement': str(actual) if count_text.isascii() else '零一二三四五六七八九十'[actual],
                    'scope': 'literal_glyph_count_only_not_document_truth'}
    return None


def validate_audit(source: DraftSource, result: Any, *, allow_literal_count: bool = False) -> dict[str, Any]:
    if not isinstance(result, dict) or result.get('source') != source.binding():
        raise ValueError('audit_source_mismatch')
    findings = result.get('findings')
    if not isinstance(findings, list) or len(findings) > 8:
        raise ValueError('invalid_findings')
    checked, seen = [], set()
    for item in findings:
        if not isinstance(item, dict):
            raise ValueError('invalid_finding')
        errors = quote_errors(source, item.get('evidence'))
        identity = item.get('id')
        if not isinstance(identity, str) or not identity or identity in seen:
            errors.append('invalid_or_duplicate_id')
        if isinstance(identity, str):
            seen.add(identity)
        if item.get('classification') not in {'conflict', 'needs_setup', 'acceptable', 'uncertain'}:
            errors.append('invalid_classification')
        for key in ('reason', 'impact', 'minimalRepair'):
            if not isinstance(item.get(key), str) or not item[key].strip():
                errors.append('missing_' + key)
        # Confidence is intentionally ignored. Exact quotations prove provenance,
        # not the model's interpretation; unresolved alternatives must stay manual.
        # An exact target quote and a label are not proof of contradiction.
        # Require a separately located counterstatement from the same effective
        # source; external/unknown facts stay manual in this minimal version.
        basis = item.get('basisEvidence')
        basis_errors = quote_errors(source, basis)
        basis_bound = item.get('basisSource') == source.binding()
        target_quotes = {e['quote'] for e in item.get('evidence', []) if isinstance(e, dict) and isinstance(e.get('quote'), str)} if isinstance(item.get('evidence'), list) else set()
        target_spans = [(source.text.index(q), source.text.index(q) + len(q)) for q in target_quotes if q and source.text.count(q) == 1]
        basis_spans = [(source.text.index(e['quote']), source.text.index(e['quote']) + len(e['quote'])) for e in basis
                       if isinstance(e, dict) and isinstance(e.get('quote'), str) and e['quote'] and source.text.count(e['quote']) == 1] if isinstance(basis, list) else []
        distinct_basis = bool(target_spans) and any(all(b <= a2 or a >= b2 for a2, b2 in target_spans) for a, b in basis_spans)
        provenance_ok = item.get('statementKind') == 'narrator_assertion' and item.get('basisStatementKind') == 'narrator_assertion'
        count_proof = literal_caption_count_proof(source, item) if allow_literal_count and not errors and not basis_errors else None
        eligible = (not errors and not basis_errors and basis_bound and distinct_basis and (provenance_ok or bool(count_proof))
                    and item.get('classification') == 'conflict' and item.get('alternativeExplanation') == 'ruled_out_with_evidence')
        if eligible and (not isinstance(item.get('alternativeReason'), str) or not item['alternativeReason'].strip()):
            eligible = False; errors.append('missing_alternative_reason')
        checked.append({**item, 'validationErrors': errors, 'eligibleForPatch': eligible,
                        'patchGate': {'basisErrors': basis_errors, 'basisSourceMatches': basis_bound,
                                      'distinctCounterstatement': bool(distinct_basis), 'narratorAssertionsOnly': provenance_ok},
                        'literalCountProof': count_proof,
                        'semanticVerification': 'model_interpretation_requires_review'})
    candidates = []
    raw_candidates = result.get('stateCandidates', [])
    if not isinstance(raw_candidates, list) or len(raw_candidates) > 6:
        raise ValueError('invalid_state_candidates')
    for candidate in raw_candidates:
        if not isinstance(candidate, dict):
            continue
        errors = quote_errors(source, candidate.get('evidence'))
        for key in ('character', 'content', 'effectiveAfter', 'eventTime', 'learnedTime', 'narrativePosition'):
            if not isinstance(candidate.get(key), str) or not candidate[key].strip():
                errors.append('missing_' + key)
        if candidate.get('epistemicStatus') not in {'observed', 'heard_claim', 'inferred', 'false_belief', 'author_truth'}:
            errors.append('invalid_epistemic_status')
        candidates.append({**candidate, 'source': source.binding(), 'status': 'candidate_only' if not errors else 'rejected', 'validationErrors': errors,
                           'temporalExtractionVerified': False, 'usableAsAutomaticKnowledge': False})
    computations = []
    raw_computations = result.get('computations', [])
    if not isinstance(raw_computations, list) or len(raw_computations) > 8:
        raise ValueError('invalid_computations')
    for fact in raw_computations:
        try:
            if not isinstance(fact, dict):
                raise ValueError('invalid_computation')
            computations.append(verify_explicit_fact(source, fact))
        except (ValueError, TypeError) as error:
            computations.append({'status': 'rejected', 'reason': str(error), 'authorizesPatch': False})
    return {'source': source.binding(), 'findings': checked, 'stateCandidates': candidates, 'computations': computations}


def candidate_current(candidate: dict[str, Any], source: DraftSource, invalidated_sources: tuple[dict[str, str], ...] = ()) -> bool:
    return candidate.get('status') == 'candidate_only' and candidate.get('source') == source.binding() and source.binding() not in invalidated_sources


def apply_patches(source: DraftSource, audit: dict[str, Any], result: Any) -> tuple[str, list[dict[str, Any]]]:
    if audit.get('source') != source.binding() or not isinstance(result, dict) or result.get('source') != source.binding():
        raise ValueError('patch_source_mismatch')
    patches = result.get('patches')
    if not isinstance(patches, list) or len(patches) > 6:
        raise ValueError('patch_count_limit')
    allowed = {f['id']: f for f in audit['findings'] if f.get('eligibleForPatch')}
    spans, used = [], set()
    for patch in patches:
        if not isinstance(patch, dict):
            raise ValueError('invalid_patch')
        old, new, identity = patch.get('old'), patch.get('new'), patch.get('findingId')
        if not isinstance(identity, str) or identity not in allowed or identity in used:
            raise ValueError('unapproved_or_duplicate_finding')
        used.add(identity)
        if not isinstance(old, str) or not old or len(old) > 400 or source.text.count(old) != 1:
            raise ValueError('patch_not_unique_or_too_large')
        if not isinstance(new, str) or len(new) > 400 or new == old:
            raise ValueError('invalid_replacement')
        start, end = source.text.index(old), source.text.index(old) + len(old)
        # Require the patch to intersect exact finding evidence, rather than
        # laundering a valid quote into permission to rewrite a remote paragraph.
        evidence_spans = [(source.text.index(e['quote']), source.text.index(e['quote']) + len(e['quote'])) for e in allowed[identity]['evidence']]
        # Every altered code point must fall inside the approved quotation.
        # A larger old string can be used as context only if its outside text is
        # byte-for-byte preserved; mere intersection is insufficient.
        import difflib
        changed = [(start + i, start + j) for tag, i, j, _, _ in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes() if tag != 'equal']
        if not changed or not all(any(a <= i and j <= b for a, b in evidence_spans) for i, j in changed):
            raise ValueError('patch_outside_evidence')
        proof = allowed[identity].get('literalCountProof')
        if proof:
            a, b = proof['countSpan']
            expected = source.text[:a] + proof['requiredReplacement'] + source.text[b:]
            proposed = source.text[:start] + new + source.text[end:]
            if proposed != expected:
                raise ValueError('literal_count_patch_must_only_correct_proven_count')
        spans.append((start, end, new, patch))
    spans.sort()
    if any(spans[i][1] > spans[i + 1][0] for i in range(len(spans) - 1)):
        raise ValueError('overlapping_patches')
    if sum(b - a for a, b, _, _ in spans) > len(source.text) * .15 or sum(len(n) for _, _, n, _ in spans) > len(source.text) * .15:
        raise ValueError('patch_coverage_limit')
    text = source.text
    for a, b, new, _ in reversed(spans):
        text = text[:a] + new + text[b:]
    return text, [p for _, _, _, p in spans]


def explicit_elapsed_minutes(start: str, end: str, end_day_offset: int) -> int:
    """Only explicit clock values/day offset; never infer midnight from prose."""
    import re
    values = []
    for clock in (start, end):
        if not isinstance(clock, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', clock):
            raise ValueError('invalid_clock')
        h, m = map(int, clock.split(':')); values.append(h * 60 + m)
    if type(end_day_offset) is not int or end_day_offset < 0:
        raise ValueError('explicit_day_offset_required')
    elapsed = values[1] + 1440 * end_day_offset - values[0]
    if elapsed < 0:
        raise ValueError('negative_elapsed')
    return elapsed


def verify_explicit_fact(source: DraftSource, fact: dict[str, Any]) -> dict[str, Any]:
    """Check narrowly specified literal extractions, not arbitrary Chinese prose.

    Even a true calculation does not certify narrator reliability or authorize a
    patch. Quoted records and character claims can be intentionally incorrect.
    """
    if fact.get('source') != source.binding() or quote_errors(source, fact.get('evidence')):
        raise ValueError('fact_source_or_evidence_invalid')
    if fact.get('statementKind') not in {'narrator_assertion', 'quoted_record', 'character_claim', 'unknown'}:
        raise ValueError('statement_provenance_required')
    quotes = [e['quote'] for e in fact['evidence']]
    if fact.get('kind') == 'elapsed_minutes':
        start, end, marker = fact.get('start'), fact.get('end'), fact.get('nextDayMarker')
        if not isinstance(start, str) or not isinstance(end, str) or not any(start in q and end in q for q in quotes):
            raise ValueError('literal_clock_values_not_in_same_evidence')
        day = fact.get('endDayOffset')
        if day == 1 and (marker != '次日' or not any(start in q and end in q and marker in q for q in quotes)):
            raise ValueError('explicit_next_day_evidence_required')
        if day not in {0, 1}:
            raise ValueError('unsupported_day_offset')
        value = explicit_elapsed_minutes(start, end, day)
    elif fact.get('kind') == 'literal_hanzi_count':
        import re
        literal = fact.get('literal')
        if not isinstance(literal, str) or not literal or not any(literal in q for q in quotes):
            raise ValueError('counted_literal_not_in_evidence')
        value = len(re.findall(r'[\u4e00-\u9fff]', literal))
    else:
        raise ValueError('unsupported_fact_kind')
    return {**fact, 'computedValue': value, 'calculationVerified': True, 'extractionVerified': False,
            'suppliedRoleAssignments': True, 'semanticErrorVerified': False, 'authorizesPatch': False}


AUDIT_INSTRUCTION = '''审核本次完整草稿，最多8项。只给JSON，必须逐字复制source对象。
输出 {source,findings:[{id,classification,evidence:[{quote}],reason,impact,minimalRepair,alternativeExplanation,alternativeReason,statementKind,basisEvidence:[{quote}],basisSource,basisStatementKind}],stateCandidates:[]}。
evidence为问题原句，basisEvidence为与之冲突的另一处精确原句；basisSource必须复制source。无法提供双方同稿证据时保留人工候选，不能捏造。statementKind/basisStatementKind为narrator_assertion/quoted_record/character_claim/unknown；只有双方都是叙述者明确断言可进入自动定点修订，其余只供人工判断。
classification为conflict/needs_setup/acceptable/uncertain。quote须正文唯一连续原文，禁止拼接或改写。每项含理由、实际影响、最小建议。
只有明确矛盾且排除合理误信/隐瞒/留白/未展示谈话并给证据时，alternativeExplanation才可填ruled_out_with_evidence，否则填possible。
缺失资料不等于人物不知道；人物可冲动、不理性、说错时间。区分事件时间/获知时间/倒叙位置/有效分支；观察、听说、推测、误信、作者真相不可混用。程序算出65分钟不表示只听“不到一小时”的姐姐已知65分钟；不为算术正确强改合理误说。保留声音、细节和自然心理，不要求解释每句话。
候选可最多6项，每项character/content/effectiveAfter/eventTime/learnedTime/narrativePosition/epistemicStatus/evidence，时间未知写“未知”；状态只候选，未采用不可写永久设定。epistemicStatus为observed/heard_claim/inferred/false_belief/author_truth。
复查时同时检查旧问题是否仍在，以及补丁引入的新问题，不能只说通过。无问题用空findings。'''

PATCH_INSTRUCTION = '''只针对eligibleFindings提供JSON {source,patches:[{findingId,old,new,reason}]}，逐字复制source。
最多6处局部替换，每处old/new<=400字符，old必须正文唯一原文并与该问题证据重合，总old与总new各<=原文15%。
保留风格、声音、留白、情绪性选择和细节；不全文重写、不为篇幅压缩全篇。无法有把握局部修复就不改，返回空patches。不要把审稿人真相注入只听错误转述的人物。'''

INTERNAL_TWO_INSTRUCTION = '''只审计本篇最多两个可由准确原文支持的内部矛盾，返回JSON findings数组，空数组合法；未发现不代表没有问题。
每项给目标evidence、独立basisEvidence、classification、reason、impact、minimalRepair、alternativeExplanation、alternativeReason、statementKind、basisStatementKind。
引用必须唯一、连续、逐字；分类conflict/needs_setup/acceptable/uncertain。来源类型narrator_assertion/quoted_record/character_claim/unknown。
排除合理解释且有证据才填alternativeExplanation=ruled_out_with_evidence，否则possible。准确引文不是判断正确的保证。
人物可误说、误信、推测；缺少说明不代表不知道。引用记录可不可靠，不能为算术正确改掉人物转述或谜题证据。不提取人物状态、不做文学评价、不评全文风格。'''

INTERNAL_PATCH_INSTRUCTION = '''仅针对提供的eligibleFindings返回JSON patches数组，每项findingId/old/new/reason。最多两处局部替换，old/new各<=400字符，总覆盖各<=15%。
old须为唯一连续原文，实际改动只能在获准目标引文内；保留其余全部文字和人物声音。不重写全文，不修未授权问题；无合法修改可返回空数组。若有literalCountProof，只改已由程序证明的那个数词。'''


async def run_postwrite_loop(source: DraftSource, context: dict[str, Any], model: Callable[[str, dict[str, Any]], Awaitable[Any]], checkpoint: Callable[[str, Any], None], *, explicit_facts: tuple[dict[str, Any], ...] = (), profile: str = 'full', supplied_candidates: dict[str, Any] | None = None) -> dict[str, Any]:
    """One audit, at most one local revision, one recheck. Callback checkpoints
    must be durable before returning; model adapters own submitted/unknown ledger.
    No retry or adoption occurs here. Any exception leaves completed checkpoints.
    """
    from .toolchains.chapter_consistency_review import review_request
    from .toolchains.schemas import ContextBundle
    bundle = ContextBundle.model_validate(context)
    if profile not in {'full', 'internal_two'}:
        raise ValueError('unknown_postwrite_profile')
    narrow = profile == 'internal_two'
    if supplied_candidates is not None and not narrow:
        raise ValueError('supplied_candidates_require_internal_two_profile')
    audit_instruction = INTERNAL_TWO_INSTRUCTION if narrow else AUDIT_INSTRUCTION
    def checked(current: DraftSource, raw: Any) -> dict[str, Any]:
        value = validate_audit(current, raw, allow_literal_count=narrow)
        if narrow and (len(value['findings']) > 2 or value['stateCandidates']):
            raise ValueError('internal_two_scope_exceeded')
        return value
    # chapter.id can be an underlying adopted chapter; source.draft_id identifies
    # this candidate draft. Never confuse their version namespaces.
    if 'content' in bundle.chapter and bundle.chapter['content'] != source.text:
        raise ValueError('context_draft_content_mismatch')
    if 'draftSource' in bundle.chapter and bundle.chapter['draftSource'] != source.binding():
        raise ValueError('context_draft_source_mismatch')
    def bound_bundle(current: DraftSource) -> ContextBundle:
        return bundle.model_copy(update={'chapter': {**bundle.chapter, 'content': current.text,
            'underlyingChapterVersion': bundle.chapter.get('underlyingChapterVersion', bundle.chapter.get('version')),
            'draftId': current.draft_id, 'version': current.version, 'branch': current.branch,
            'contentHash': sha256(current.text), 'draftSource': current.binding()}})
    bundle = bound_bundle(source)
    payload = review_request('写后证据审计与定点修订', 'zh-CN', bundle, ['人物认知', '连续性'])
    payload.update({'source': source.binding(), 'draft': source.text, 'instruction': audit_instruction})
    checkpoint('source', {'source': source.binding(), 'text': source.text})
    if len(explicit_facts) > 8:
        raise ValueError('explicit_fact_count_limit')
    program_checks = [verify_explicit_fact(source, fact) for fact in explicit_facts]
    checkpoint('program-checks', {'source': source.binding(), 'computations': program_checks})
    payload['programChecks'] = program_checks
    if supplied_candidates is None:
        raw = await model('chapter.consistency_review', payload)
        checkpoint('audit-raw', raw)
        audit = checked(source, raw)
    else:
        # Explicit assisted entry; never masquerade supplied issues as a model audit.
        from .postwrite_supplied import validate_supplied_count_candidates
        checkpoint('supplied-candidates', supplied_candidates)
        audit = validate_supplied_count_candidates(source, supplied_candidates)
    checkpoint('audit', audit)
    eligible = [f for f in audit['findings'] if f['eligibleForPatch']]
    revised, patches = source.text, []
    if eligible:
        patch_raw = await model('chapter.rewrite', {**payload, 'instruction': INTERNAL_PATCH_INSTRUCTION if narrow else PATCH_INSTRUCTION, 'eligibleFindings': eligible})
        checkpoint('patch-proposal', patch_raw)
        try:
            if narrow and (not isinstance(patch_raw, dict) or not isinstance(patch_raw.get('patches'), list) or len(patch_raw['patches']) > 2):
                raise ValueError('internal_two_patch_scope_exceeded')
            revised, patches = apply_patches(source, audit, patch_raw)
        except ValueError as error:
            checkpoint('patch-rejected', {'reason': str(error), 'source': source.binding()})
    replacement = DraftSource(revised, source.draft_id, source.version + '+postwrite-1', source.branch) if patches else source
    checkpoint('revision', {'source': replacement.binding(), 'text': revised, 'patches': patches,
                           'invalidatedCandidateSources': [source.binding()] if patches else []})
    if narrow and not patches:
        result = {'status': 'revision_not_validated', 'source': source.binding(), 'revisedSource': source.binding(),
                  'text': source.text, 'patches': [], 'audit': audit, 'recheck': None, 'adopted': False,
                  'reason': 'no_legal_nonempty_patch', 'invalidatedCandidateSources': [], 'programChecks': program_checks}
        if supplied_candidates is not None:
            result.update({'discoveryMode': 'supplied_verified_issue', 'autonomousDiscoveryTested': False})
        checkpoint('result', result)
        return result
    recheck_raw = await model('chapter.consistency_review', {**payload, 'contextBundle': bound_bundle(replacement).model_dump(),
        'instruction': audit_instruction, 'source': replacement.binding(), 'draft': revised,
        'programChecks': program_checks if not patches else [],
        'historicalProgramChecks': program_checks if patches else [],
        'previousFindings': audit['findings'], 'appliedPatches': patches})
    checkpoint('recheck-raw', recheck_raw)
    recheck = checked(replacement, recheck_raw); checkpoint('recheck', recheck)
    result = {'status': 'draft_review_required', 'source': source.binding(), 'revisedSource': replacement.binding(), 'text': revised, 'patches': patches, 'audit': audit, 'recheck': recheck,
              'invalidatedCandidateSources': [source.binding()] if patches else [], 'programChecks': program_checks, 'adopted': False}
    if supplied_candidates is not None:
        from .postwrite_supplied import verify_supplied_revision
        result.update({'discoveryMode': 'supplied_verified_issue', 'autonomousDiscoveryTested': False,
                       'suppliedRevisionChecks': verify_supplied_revision(source, replacement, audit)})
    checkpoint('result', result)
    return result
