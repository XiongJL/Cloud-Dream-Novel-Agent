"""Product routing for newly authored style packs; never rewrites old revisions."""
WRITING_OPERATIONS = {'chapter.create', 'chapter.continuation', 'chapter.sequence_continuation', 'chapter.rewrite', 'chapter.batch_rewrite'}


def normalize_style_routing(plan, *, source_driven=False):
    core = next(m for m in plan.skills if m.draftKey == 'language_style')
    choices = {}
    for binding in plan.pack.bindings:
        if binding.roleId == 'writer' and binding.operationId in WRITING_OPERATIONS:
            if binding.operationId not in core.supportedOperations or 'writer' not in core.allowedRoles:
                raise ValueError('语言核心必须支持文风包所声明的写作任务。')
            binding.primaryDraftKey = 'language_style'
            candidates = [m.draftKey for m in plan.skills if m.draftKey != 'language_style'
                          and binding.operationId in m.supportedOperations and 'writer' in m.allowedRoles]
            binding.auxiliaryDraftKey = ((binding.auxiliaryDraftKey if binding.auxiliaryDraftKey in candidates else None)
                if source_driven else ('suspense_release' if 'suspense_release' in candidates else None)) if binding.operationId != 'chapter.batch_rewrite' else None
            choices[binding.operationId + ':' + binding.roleId] = candidates
    return {'version': 2, 'coreDraftKey': 'language_style', 'auxiliaryChoices': choices}


def writing_combinations(plan, routing):
    result = {}
    for binding in plan.pack.bindings:
        if binding.roleId != 'writer' or binding.operationId not in WRITING_OPERATIONS:
            continue
        choices = routing.get('auxiliaryChoices', {}).get(binding.operationId + ':' + binding.roleId, [])
        for auxiliary in [binding.auxiliaryDraftKey, *choices]:
            pair = (binding.primaryDraftKey, auxiliary)
            result.setdefault(pair, binding.operationId)
    return result
