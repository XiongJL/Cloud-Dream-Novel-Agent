"""Source measurements and bounded validation references; never writing quotas."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from uuid import uuid4

from .skill_analysis_graph import fingerprint


def fidelity_enabled(refs) -> bool:
    return any(ref.stableId == 'builtin.style-skill-extractor' and ref.version == '1.4.0' for ref in refs)


def distribution(values: list[int | float]) -> dict:
    ordered = sorted(values)
    if not ordered:
        return {'count': 0}
    return {'count': len(ordered), **{name: ordered[round((len(ordered) - 1) * q)]
        for name, q in [('min', 0), ('p25', .25), ('median', .5), ('p75', .75), ('max', 1)]}}


def chapter_profile(chapter: dict) -> dict:
    text = str(chapter.get('content') or '')
    paragraphs = [p.strip() for p in re.split(r'\n+', text) if p.strip()]
    sentences = [s.strip() for s in re.split(r'[。！？!?]+|(?<!\d)\.(?!\d)', text) if s.strip()]
    quoted = re.findall(r'“[^”]*”|「[^」]*」|"[^"\n]*"', text)
    speech = [p for p in paragraphs if re.search(r'[“「"]', p)]
    narrative = [p for p in paragraphs if p not in speech]
    samples = []
    for kind, choices in [('quoted_speech', speech), ('narrative', narrative), ('ending', paragraphs[-1:])]:
        if choices:
            snippet = choices[len(choices) // 2][:300]
            samples.append({'kind': kind, 'text': snippet, 'startOffset': text.find(snippet)})
    return {'chapterId': chapter['chapterId'], 'contentHash': chapter['contentHash'],
        'version': chapter.get('version'), 'characters': len(text),
        'sentenceLengths': distribution([len(s) for s in sentences]),
        'paragraphLengths': distribution([len(p) for p in paragraphs]),
        'quotedCharacterRatio': round(sum(len(q) for q in quoted) / max(1, len(text)), 4),
        'passageGroups': {'quoted_speech': len(speech), 'narrative': len(narrative)}, 'samples': samples,
        'measurementNote': '按正文标点和换行粗分，长度含标点；引语标记比例不等于全部对白比例。场景分类仍需语义核对。'}


def _path(state_dir: Path, chapter: dict) -> Path:
    return state_dir / 'style-profile-cache' / (fingerprint([chapter['chapterId'], chapter['contentHash']]) + '.json')


def save_profile(state_dir: Path, chapter: dict) -> None:
    path = _path(state_dir, chapter)
    path.parent.mkdir(exist_ok=True)
    temporary = path.with_suffix('.' + uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(chapter_profile(chapter), ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_profiles(state_dir: Path, snapshots: list[dict]) -> list[dict]:
    result = []
    for snapshot in snapshots:
        try:
            value = json.loads(_path(state_dir, snapshot).read_text(encoding='utf-8'))
            if value['chapterId'] == snapshot['chapterId'] and value['contentHash'] == snapshot['contentHash']:
                result.append(value)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return result


async def ensure_profiles(state_dir: Path, snapshots: list[dict], read) -> list[dict]:
    """Rebuild missing measurements without calling a model or changing the frozen source."""
    import asyncio
    from .toolchains.schemas import ToolchainError
    cached = {p['chapterId']: p for p in await asyncio.to_thread(load_profiles, state_dir, snapshots)}
    for snapshot in snapshots:
        if snapshot['chapterId'] in cached:
            continue
        material = await read(snapshot)
        if (not isinstance(material, dict) or any(material.get(key) != snapshot.get(key)
                for key in ('chapterId', 'contentHash', 'version')) or not str(material.get('content') or '').strip()):
            raise ToolchainError('CONTEXT_INSUFFICIENT', '来源风格统计缺失，且当前正文与冻结来源不符；不能补造统计或继续来源一致性验收。')
        await asyncio.to_thread(save_profile, state_dir, material)
        cached[snapshot['chapterId']] = chapter_profile(material)
    return [cached[s['chapterId']] for s in snapshots]


def split_profiles(profiles: list[dict]) -> tuple[dict, dict]:
    # Hold out chapters from rule authoring when enough independently measured chapters exist.
    count = min(2, max(1, len(profiles) // 5)) if len(profiles) >= 5 else 0
    reserved = {round((i + 1) * (len(profiles) - 1) / (count + 1)) for i in range(count)}
    validation = [p for i, p in enumerate(profiles) if i in reserved]
    learning = [p for i, p in enumerate(profiles) if i not in reserved]
    indices = sorted({round(i * (len(learning) - 1) / 5) for i in range(6)}) if len(learning) > 6 else range(len(learning))
    public = {'version': 2, 'measuredChapterCount': len(profiles), 'learningChapterCount': len(learning),
        'learningChapterIds': [learning[i]['chapterId'] for i in indices],
        'validationChapterIds': [p['chapterId'] for p in validation],
        'chapterDistributions': [{k: v for k, v in learning[i].items() if k != 'samples'} for i in indices],
        'aggregateDistributions': {
            'sentenceMedianAcrossChapters': distribution([p['sentenceLengths']['median'] for p in learning if p['sentenceLengths']['count']]),
            'paragraphMedianAcrossChapters': distribution([p['paragraphLengths']['median'] for p in learning if p['paragraphLengths']['count']]),
            'quotedCharacterRatioAcrossChapters': distribution([p['quotedCharacterRatio'] for p in learning]),
        },
        'completeMeasurementsHash': fingerprint(profiles),
        'interpretation': '分布描述获准样本，不作为生成配额；按场景核对节奏、心理叙述和人物声音。缺失统计不得补造。'}
    reference = {'version': 2, 'heldOut': bool(validation),
        'samples': [{'chapterId': p['chapterId'], 'contentHash': p['contentHash'], **sample}
            for p in (validation or learning[-2:]) for sample in p['samples']],
        'limitation': '保留章节仅用于验收，不进入规则编写证据。' if validation else '样本不足，参考片段未独立保留；不能声明跨场景来源一致性已充分验证。'}
    public['validationReferenceHash'] = fingerprint(reference)
    return public, reference


def authoring_evidence(pages: list[list[dict]], reviews: list[dict], held_out: set[str]) -> tuple[list[list[dict]], list[dict]]:
    if not held_out:
        return pages, reviews
    allowed = {candidate['findingRef'] for page in pages for candidate in page
        if not any(e.get('sourceId') in held_out for e in candidate.get('evidence', []))}
    return ([[c for c in page if c['findingRef'] in allowed] for page in pages],
        [{**review, 'decisions': [d for d in review['decisions'] if d['findingRef'] in allowed]} for review in reviews])
