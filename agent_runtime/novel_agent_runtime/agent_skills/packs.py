"""Resolve one published pack atomically, without dispatching a model."""
from __future__ import annotations
from typing import Any, Literal
from pydantic import BaseModel, model_validator
from .errors import AgentSkillError
from .schemas import AgentSkillRef


class SkillPackRequest(BaseModel):
    packId: str
    requestedPackRevisionId: str | None = None
    auxiliaryMode: Literal['default', 'none', 'member'] = 'default'
    auxiliaryMemberKey: str | None = None

    @model_validator(mode='after')
    def validate_member(self):
        if not self.packId or (self.auxiliaryMode == 'member' and not self.auxiliaryMemberKey):
            raise ValueError('Pack and explicit auxiliary identities are required')
        return self


def resolve_pack(pack: dict[str, Any], request: SkillPackRequest, operation: str, role: str,
                 novel_id: str | None, source: str = 'explicit') -> tuple[list[AgentSkillRef], dict[str, Any]]:
    if pack.get('id') != request.packId or (request.requestedPackRevisionId and pack.get('revisionId') != request.requestedPackRevisionId):
        raise AgentSkillError('AGENT_SKILL_PACK_VERSION_UNAVAILABLE', '所选文风包版本不可用。')
    if pack.get('scope') == 'novel' and pack.get('ownerNovelId') != novel_id:
        raise AgentSkillError('AGENT_SKILL_PACK_SCOPE_MISMATCH', '该文风包不属于当前小说。')
    bindings = [b for b in pack.get('bindings', []) if b['operationId'] == operation and b['roleId'] == role]
    selection = dict(packId=pack['id'], title=pack['title'], revisionId=pack['revisionId'], version=pack['version'],
                     contentHash=pack['contentHash'], source=source, operationId=operation, roleId=role,
                     auxiliaryMode=request.auxiliaryMode, reasonCodes=[])
    if not bindings:
        return [], {**selection, 'applicable': False, 'reasonCodes': ['pack_not_applicable']}
    if not pack.get('available'):
        raise AgentSkillError('AGENT_SKILL_PACK_UNAVAILABLE', '文风包或成员已停用/不可用，请重新选择。')
    if len(bindings) != 1:
        raise AgentSkillError('AGENT_SKILL_PACK_BINDING_INVALID', '文风包存在重复任务绑定。')
    binding = bindings[0]
    auxiliary = binding.get('auxiliary') if request.auxiliaryMode == 'default' else None
    if request.auxiliaryMode == 'member':
        if request.auxiliaryMemberKey not in binding.get('allowedAuxiliaryMemberKeys', []):
            raise AgentSkillError('AGENT_SKILL_PACK_AUXILIARY_UNSUPPORTED', '所选辅助方法不适用于此任务，请更换辅助或重新规划。')
        auxiliary = next((m for m in pack['members'] if m['memberKey'] == request.auxiliaryMemberKey), None)
        if auxiliary is None:
            raise AgentSkillError('AGENT_SKILL_PACK_MEMBER_UNAVAILABLE', '文风包缺少所选辅助成员。')
    refs = []
    for member in [binding['primary'], auxiliary]:
        if member is None:
            continue
        if (not member.get('enabled') or operation not in member['supportedOperations']
                or (member['allowedRoles'] and role not in member['allowedRoles'])
                or any(r.skillId == member['skillId'] for r in refs)):
            raise AgentSkillError('AGENT_SKILL_PACK_MEMBER_INCOMPATIBLE', '文风包成员与此任务/角色不兼容。')
        refs.append(AgentSkillRef(skillId=member['skillId'], stableId=member.get('stableId', member['skillId']),
            revisionId=member['revisionId'], version=member['version'], contentHash=member['contentHash'],
            scope=member.get('scope', pack['scope']), selectionSource='preset', position='primary' if not refs else 'auxiliary'))
    return refs, {**selection, 'applicable': True, 'reasonCodes': ['pack_binding_selected', 'auxiliary_' + request.auxiliaryMode]}
