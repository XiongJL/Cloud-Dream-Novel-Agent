"""Opt-in reviewed count candidates. No autonomous anaphora resolution or canon writes.

The trusted caller supplies review provenance, never the model response. Exact
source/quotes and the caption count are reverified. A secondary reference needs
an explicit reviewer attestation; that semantic link is not a program discovery.
"""
from __future__ import annotations

import re
from typing import Any

from .postwrite_audit import DraftSource, quote_errors, validate_audit, verify_explicit_fact


def validate_supplied_count_candidates(source: DraftSource, supplied: dict[str, Any]) -> dict[str, Any]:
    if supplied.get('source') != source.binding():
        raise ValueError('supplied_source_mismatch')
    provenance = supplied.get('provenance', {})
    if (provenance.get('kind') != 'user_supplied_verified_issue'
            or not all(isinstance(provenance.get(k), str) and provenance[k].strip()
                       for k in ('request', 'reviewer'))):
        raise ValueError('external_review_provenance_required')
    anchor = supplied.get('anchor')
    if not isinstance(anchor, dict):
        raise ValueError('supplied_anchor_required')
    audit = validate_audit(source, {'source': source.binding(), 'findings': [anchor]}, allow_literal_count=True)
    checked_anchor = audit['findings'][0]
    proof = checked_anchor['literalCountProof']
    if not checked_anchor['eligibleForPatch'] or not proof:
        raise ValueError('supplied_anchor_not_program_proven')
    computation = verify_explicit_fact(source, {'source': source.binding(), 'kind': 'literal_hanzi_count',
        'statementKind': 'quoted_record', 'evidence': anchor['basisEvidence'], 'literal': proof['literal']})
    references = supplied.get('reviewedReferences', [])
    if not isinstance(references, list) or len(references) > 1:
        raise ValueError('supplied_two_location_limit')
    checked_anchor.update({'candidateOrigin': provenance, 'semanticVerification': 'program_caption_layout_count'})
    used = {anchor['id']}
    occupied = [tuple(proof['countSpan'])]
    for reference in references:
        if not isinstance(reference, dict):
            raise ValueError('invalid_reviewed_reference')
        review = reference.get('relationReview', {})
        if (review.get('anchorId') != anchor['id'] or review.get('decision') != 'same_literal_confirmed'
                or review.get('reviewer') != provenance['reviewer']):
            raise ValueError('reviewed_reference_link_required')
        identity, evidence = reference.get('id'), reference.get('evidence')
        if not isinstance(identity, str) or not identity or identity in used:
            raise ValueError('invalid_reference_id')
        used.add(identity)
        if quote_errors(source, evidence) or len(evidence) != 1 or reference.get('statementKind') != 'narrator_assertion':
            raise ValueError('reviewed_reference_evidence_invalid')
        quote = evidence[0]['quote']
        matches = list(re.finditer(r'(?P<count>[一二三四五六七八九十0-9]{1,2})个字', quote))
        if len(matches) != 1:
            raise ValueError('reviewed_reference_count_not_unique')
        match = matches[0]
        count_text = match['count']
        numbers = {c: n for n, c in enumerate('零一二三四五六七八九十')}
        declared = int(count_text) if count_text.isascii() and count_text.isdigit() else numbers.get(count_text)
        if declared != proof['declared']:
            raise ValueError('reviewed_reference_declared_count_mismatch')
        start = source.text.index(quote) + match.start('count')
        span = (start, start + len(count_text))
        if any(span[0] < b and a < span[1] for a, b in occupied):
            raise ValueError('duplicate_count_location')
        occupied.append(span)
        replacement = str(proof['actual']) if count_text.isascii() else '零一二三四五六七八九十'[proof['actual']]
        audit['findings'].append({**checked_anchor, 'id': identity, 'evidence': evidence,
            'reason': reference.get('reason') or '已审核回指同一题字，字面计数应一致。',
            'candidateOrigin': provenance, 'relationReview': review,
            'semanticVerification': 'caller_reviewed_reference_not_automatic_inference',
            'literalCountProof': {**proof, 'countSpan': list(span), 'requiredReplacement': replacement,
                'scope': 'reviewed_reference_glyph_count_only_not_document_truth', 'anchorId': anchor['id']}})
    audit.update({'candidateOrigin': provenance, 'discoveryMode': 'supplied_verified_issue',
                  'autonomousDiscoveryTested': False, 'computations': [computation]})
    return audit


def verify_supplied_revision(original: DraftSource, revised: DraftSource, audit: dict[str, Any]) -> dict[str, Any]:
    """Check every approved occurrence and preserve every other code point.

    These mechanical checks do not certify the absence of semantic problems.
    """
    if audit.get('source') != original.binding() or revised.draft_id != original.draft_id or revised.branch != original.branch:
        raise ValueError('supplied_revision_source_mismatch')
    expected = original.text
    locations = sorted((f['literalCountProof']['countSpan'], f) for f in audit['findings'])
    for (a, b), finding in reversed(locations):
        expected = expected[:a] + finding['literalCountProof']['requiredReplacement'] + expected[b:]
    shift, checks = 0, []
    for (a, b), finding in locations:
        replacement = finding['literalCountProof']['requiredReplacement']
        start = a + shift
        checks.append({'findingId': finding['id'], 'originalSpan': [a, b], 'revisedSpan': [start, start + len(replacement)],
                       'expected': replacement, 'verified': revised.text[start:start + len(replacement)] == replacement})
        shift += len(replacement) - (b - a)
    return {'source': original.binding(), 'revisedSource': revised.binding(), 'locations': checks,
            'allRelatedLocationsCorrected': all(c['verified'] for c in checks),
            'exactlyApprovedChangesOnly': revised.text == expected,
            'versionAdvanced': revised.version != original.version,
            'semanticSafety': 'requires_recheck_and_editor_review'}
