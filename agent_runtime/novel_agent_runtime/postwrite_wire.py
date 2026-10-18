"""Opt-in compact DeepSeek Responses projection; ordinary writing is unchanged."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .postwrite_audit import DraftSource, sha256


def digest_request(body: dict[str, Any]) -> str:
    return sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':')))


def response_schema(phase: str) -> dict[str, Any]:
    def string(**extra: Any) -> dict[str, Any]:
        return {'type': 'string', 'minLength': 1, 'maxLength': 400, **extra}
    def obj(properties: dict[str, Any]) -> dict[str, Any]:
        return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}
    quote = {'type': 'array', 'items': obj({'quote': string()}), 'minItems': 1, 'maxItems': 2}
    if phase == 'patch':
        item = obj({'findingId': string(), 'old': string(), 'new': {'type': 'string', 'maxLength': 400}, 'reason': string()})
        return obj({'patches': {'type': 'array', 'items': item, 'maxItems': 2}})
    if phase not in {'audit', 'recheck'}:
        raise ValueError('invalid_wire_phase')
    kinds = ['narrator_assertion', 'quoted_record', 'character_claim', 'unknown']
    item = obj({'classification': string(enum=['conflict', 'needs_setup', 'acceptable', 'uncertain']),
                'evidence': quote, 'basisEvidence': quote, 'statementKind': string(enum=kinds),
                'basisStatementKind': string(enum=kinds), 'reason': string(), 'impact': string(),
                'minimalRepair': string(), 'alternativeExplanation': string(enum=['ruled_out_with_evidence', 'possible']),
                'alternativeReason': string()})
    return obj({'findings': {'type': 'array', 'items': item, 'maxItems': 2}})


def validate_wire(value: Any, schema: dict[str, Any]) -> None:
    """Validate the small schema locally even if server accepts but ignores it."""
    kind = schema['type']
    if kind == 'object':
        if not isinstance(value, dict) or set(value) != set(schema['properties']):
            raise ValueError('wire_object_fields_invalid')
        for key, child in schema['properties'].items():
            validate_wire(value[key], child)
    elif kind == 'array':
        if not isinstance(value, list) or not schema.get('minItems', 0) <= len(value) <= schema['maxItems']:
            raise ValueError('wire_array_scope_invalid')
        for item in value:
            validate_wire(item, schema['items'])
    elif kind == 'string':
        if not isinstance(value, str) or not schema.get('minLength', 0) <= len(value) <= schema['maxLength'] or ('enum' in schema and value not in schema['enum']):
            raise ValueError('wire_string_invalid')
    else:
        raise ValueError('unsupported_local_schema')


def build_request(source: DraftSource, payload: dict[str, Any], phase: str, model: str, output_limit: int) -> dict[str, Any]:
    if payload.get('source') != source.binding() or payload.get('draft') != source.text:
        raise ValueError('wire_source_mismatch')
    content: dict[str, Any] = {'draft': source.text}
    if phase == 'patch':
        content['eligibleFindings'] = [{key: finding[key] for key in ('id', 'evidence', 'basisEvidence', 'reason', 'minimalRepair') if key in finding}
                                       for finding in payload.get('eligibleFindings', [])]
        for projected, finding in zip(content['eligibleFindings'], payload.get('eligibleFindings', [])):
            proof = finding.get('literalCountProof')
            if proof:
                projected['literalCountProof'] = {key: proof[key] for key in ('literal', 'declared', 'actual', 'requiredReplacement')}
    elif phase == 'recheck':
        content['historicalIssues'] = [{key: finding[key] for key in ('id', 'evidence', 'reason') if key in finding}
                                      for finding in payload.get('previousFindings', [])]
        content['appliedPatches'] = payload.get('appliedPatches', [])
    instruction = payload['instruction']
    if phase == 'recheck':
        instruction += '\n历史问题引文只用于追踪旧问题，不是当前正文。请核对旧问题是否解决及本轮新引入问题；以draft为唯一当前正文。'
    return {'model': model, 'reasoning': {'effort': 'none'},
            'text': {'format': {'type': 'json_schema', 'name': 'postwrite_' + phase, 'schema': response_schema(phase)}},
            'instructions': instruction, 'input': json.dumps(content, ensure_ascii=False, separators=(',', ':')),
            'max_output_tokens': output_limit, 'stream': True}


@dataclass(frozen=True)
class ResponseBinding:
    record_key: str
    phase: str
    source: DraftSource
    request_sha256: str


def consume_response(binding: ResponseBinding, request: dict[str, Any], record: dict[str, Any],
                     created_response_id: str, terminal_response_id: str, *, submitted_binding: dict[str, Any]) -> dict[str, Any]:
    """Bind on local request ledger + this stream; model never echoes metadata."""
    if binding.request_sha256 != digest_request(request) or json.loads(request['input'])['draft'] != binding.source.text:
        raise ValueError('bound_request_changed')
    if submitted_binding != {'recordKey': binding.record_key, 'phase': binding.phase, 'source': binding.source.binding(), 'requestSha256': binding.request_sha256}:
        raise ValueError('submission_source_or_phase_mismatch')
    if request['text']['format'].get('name') != 'postwrite_' + binding.phase:
        raise ValueError('bound_phase_mismatch')
    if record.get('key') != binding.record_key or not created_response_id or created_response_id != terminal_response_id or record.get('responseId') != terminal_response_id:
        raise ValueError('bound_response_mismatch')
    if record.get('status') != 'completed':
        raise ValueError('incomplete_response_not_consumable')
    value = json.loads(record['text'])
    validate_wire(value, response_schema(binding.phase))
    source = binding.source.binding()
    if binding.phase == 'patch':
        return {'source': source, 'patches': value['patches']}
    return {'source': source, 'findings': [{**item, 'id': f'F{index + 1}', 'basisSource': source}
                                         for index, item in enumerate(value['findings'])]}


def token_breakdown(usage: dict[str, Any]) -> dict[str, Any]:
    output = usage.get('output_tokens')
    reasoning = (usage.get('output_tokens_details') or {}).get('reasoning_tokens')
    if type(output) is not int or type(reasoning) is not int or not 0 <= reasoning <= output:
        raise ValueError('token_breakdown_unavailable_or_invalid')
    return {'inputTokens': usage.get('input_tokens'), 'totalOutputTokens': output, 'reasoningTokens': reasoning,
            'nonReasoningOutputTokens': output - reasoning, 'totalTokens': usage.get('total_tokens'),
            'finalTokenMethod': 'provider_output_minus_reasoning_not_text_character_count'}
