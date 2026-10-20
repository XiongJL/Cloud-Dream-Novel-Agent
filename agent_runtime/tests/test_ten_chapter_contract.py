import pytest
from types import SimpleNamespace
from pydantic import ValidationError
from novel_agent_runtime.intent.rules import requested_continuation_chapter_count, requested_created_chapter_count, detect_explicit_operations
from novel_agent_runtime.toolchains.schemas import ChapterSequenceContinuationInput, ChapterBatchRewriteInput
from novel_agent_runtime.agent_skills.registry import STYLE_SKILL_EXTRACTOR_QUALITY_REVISION, STYLE_SKILL_EXTRACTOR_FIDELITY_REVISION
from novel_agent_runtime.toolchains.chapter_sequence_continuation import sequence_child_params


@pytest.mark.parametrize('count', [1, 2, 5, 10])
def test_all_multi_chapter_batches_require_actual_state_before_advancing(count):
    data = ChapterSequenceContinuationInput(novelId='book', volumeId='volume', chapterId='anchor', goal='新写', chapterCount=count)
    beat = SimpleNamespace(title='新章', targetWordCount=2300, model_dump=lambda: {'title': '新章'})
    batch = SimpleNamespace(draftBatchId='batch', outline=SimpleNamespace(revision=1, beats=[beat] * count),
                            children=[SimpleNamespace(generationRevision=1)] * count,
                            stateLedger=SimpleNamespace(model_dump=lambda: {}))
    params = sequence_child_params(data, batch, 0, {'generationPolicyVersion': 2}, [])
    assert params['batchContext']['requireVerifiedState'] is (count > 1)
    frozen = sequence_child_params(data, batch, 0, {}, [])
    assert frozen['batchContext']['requireVerifiedState'] is (count > 5)


@pytest.mark.parametrize('message', ['连续新写10章', '连续新写十章', '新写十章', '从第89章后连续续写十章'])
def test_ten_chapters_are_a_count_not_a_target_ordinal(message):
    assert requested_continuation_chapter_count(message) == 10
    assert 'chapter.sequence_continuation' in detect_explicit_operations(message)


def test_oversized_count_is_rejected_instead_of_silently_reduced():
    count = requested_created_chapter_count('连续新写十一章')
    assert count == 11
    payload = dict(novelId='book', volumeId='volume', chapterId='anchor', goal='写新章')
    assert ChapterSequenceContinuationInput(**payload, chapterCount=10).chapterCount == 10
    with pytest.raises(ValidationError):
        ChapterSequenceContinuationInput(**payload, chapterCount=count)
    with pytest.raises(ValidationError):
        ChapterBatchRewriteInput(**payload, chapterIds=['chapter'], chapterCount=6)


def test_old_style_revision_stays_separate_from_new_source_acceptance():
    assert STYLE_SKILL_EXTRACTOR_QUALITY_REVISION.version == '1.3.0'
    assert STYLE_SKILL_EXTRACTOR_QUALITY_REVISION.manifest['qualityAcceptance'] == 'evidence-document-trial-v1'
    assert '规划必须包含语言风格、悬念与信息释放' in STYLE_SKILL_EXTRACTOR_QUALITY_REVISION.instructions
    assert STYLE_SKILL_EXTRACTOR_FIDELITY_REVISION.manifest['qualityAcceptance'] == 'evidence-document-trial-v2'
    assert '规划必须包含语言风格、悬念与信息释放' not in STYLE_SKILL_EXTRACTOR_FIDELITY_REVISION.instructions
    assert '互动和过渡两个' in STYLE_SKILL_EXTRACTOR_FIDELITY_REVISION.instructions
