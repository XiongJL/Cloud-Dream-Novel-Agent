from __future__ import annotations

import json
import asyncio
import pytest

from novel_agent_runtime.style_fidelity import chapter_profile, save_profile, load_profiles, split_profiles, authoring_evidence, ensure_profiles
from novel_agent_runtime.style_quality import validate_quality, FIDELITY_TRIAL_CRITERIA
from novel_agent_runtime.toolchains.schemas import ToolchainError, StyleSkillPackAuthoringPlan
from test_style_quality import plan_binding


def sample(index=0):
    return {'chapterId': f'chapter-{index}', 'contentHash': str(index) * 64 or '0' * 64, 'version': 1,
        'content': '她把事情想了一遍，决定明天再来。\n“那就明天吧。”他说。\n她出了门，沿着街走回去。'}


def test_profile_is_descriptive_and_cache_is_source_hash_bound(tmp_path):
    profile = chapter_profile(sample())
    assert profile['paragraphLengths']['count'] == 3
    assert profile['sentenceLengths']['count'] == 4
    assert 0 < profile['quotedCharacterRatio'] < 1
    save_profile(tmp_path, sample())
    assert load_profiles(tmp_path, [sample()]) == [profile]
    changed = {**sample(), 'contentHash': 'different'}
    assert load_profiles(tmp_path, [changed]) == []


def test_reference_chapters_are_excluded_from_rule_authoring_and_input_is_bounded():
    profiles = [chapter_profile(sample(i)) for i in range(500)]
    public, private = split_profiles(profiles)
    assert public['learningChapterCount'] == 498
    assert len(public['chapterDistributions']) == 6
    assert len(json.dumps(public, ensure_ascii=False).encode()) < 10_000
    assert private['heldOut'] and len(private['samples']) <= 6
    withheld = set(public['validationChapterIds'])
    candidates = [{'findingRef': f'unit-{i}', 'evidence': [{'sourceId': p['chapterId']}]} for i, p in enumerate(profiles)]
    decisions = [{'findingRef': c['findingRef']} for c in candidates]
    pages, reviews = authoring_evidence([candidates], [{'decisions': decisions}], withheld)
    assert len(pages[0]) == len(reviews[0]['decisions']) == 498
    assert all(c['evidence'][0]['sourceId'] not in withheld for c in pages[0])
    assert not any(s['text'] in json.dumps(public, ensure_ascii=False) for s in private['samples'])


def test_limited_samples_do_not_claim_held_out_validation():
    public, private = split_profiles([chapter_profile(sample())])
    assert not private['heldOut'] and public['validationChapterIds'] == []
    assert '样本不足' in private['limitation']


def test_fidelity_trials_require_source_and_rhythm_checks():
    report = {'phase': 'trial', 'summary': '按片段比较表达差异', 'checks': {k: 'pass' for k in FIDELITY_TRIAL_CRITERIA}, 'issues': []}
    assert validate_quality(report, 'trial', {'fidelityMode': 2})['accepted']
    report['checks']['source_fidelity'] = 'unverified'
    assert not validate_quality(report, 'trial', {'fidelityMode': 2})['accepted']
    del report['checks']['rhythm_variation']
    with pytest.raises(ToolchainError):
        validate_quality(report, 'trial', {'fidelityMode': 2})


def test_single_language_member_is_a_valid_pack():
    plan = plan_binding()
    plan['skills'] = plan['skills'][:1]
    for binding in plan['pack']['bindings']:
        binding['primaryDraftKey'] = 'language_style'
        binding['auxiliaryDraftKey'] = None
    assert len(StyleSkillPackAuthoringPlan.model_validate(plan).skills) == 1


def test_missing_measurements_rebuild_from_frozen_text_without_model_calls(tmp_path):
    async def scenario():
        calls = []
        snapshots = [{k: v for k, v in sample(i).items() if k != 'content'} for i in range(2)]
        async def read(snapshot):
            calls.append(snapshot['chapterId'])
            return sample(int(snapshot['chapterId'].split('-')[1]))
        assert len(await ensure_profiles(tmp_path, snapshots, read)) == 2
        assert len(await ensure_profiles(tmp_path, snapshots, read)) == 2
        assert calls == ['chapter-0', 'chapter-1']
        async def changed(snapshot):
            return {**sample(9), 'contentHash': 'different'}
        with pytest.raises(ToolchainError, match='冻结来源'):
            await ensure_profiles(tmp_path, [{k: v for k, v in sample(9).items() if k != 'content'}], changed)
    asyncio.run(scenario())
