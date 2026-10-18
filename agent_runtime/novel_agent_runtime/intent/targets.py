from __future__ import annotations

import re
from typing import Any

from .schemas import ResolvedChapterCandidate, ResolvedIntentTarget


_ZH_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}


def _positive_number(value: str) -> int | None:
    normalized = value.strip()
    if normalized.isdigit():
        number = int(normalized)
        return number if number > 0 else None
    if normalized in _ZH_DIGITS:
        number = _ZH_DIGITS[normalized]
        return number if number > 0 else None
    if "百" in normalized:
        head, tail = normalized.split("百", 1)
        hundreds = _ZH_DIGITS.get(head, 1 if not head else -1)
        if hundreds < 0:
            return None
        remainder = _positive_number(tail) if tail else 0
        return hundreds * 100 + (remainder or 0)
    if "十" in normalized:
        head, tail = normalized.split("十", 1)
        tens = _ZH_DIGITS.get(head, 1 if not head else -1)
        ones = _ZH_DIGITS.get(tail, 0 if not tail else -1)
        if tens < 0 or ones < 0:
            return None
        return tens * 10 + ones
    digits = [_ZH_DIGITS.get(character) for character in normalized]
    if digits and all(digit is not None for digit in digits):
        number = int("".join(str(digit) for digit in digits))
        return number if number > 0 else None
    return None


def _normalized_catalog(raw_catalog: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_catalog, list):
        return []
    entries: list[dict[str, Any]] = []
    for source_index, item in enumerate(raw_catalog):
        if not isinstance(item, dict):
            continue
        nested_chapters = item.get("chapters")
        if isinstance(nested_chapters, list):
            volume_id = str(item.get("volumeId") or item.get("id") or "").strip() or None
            volume_title = str(item.get("volumeTitle") or item.get("title") or "").strip()
            volume_order = int(item.get("volumeOrder") or item.get("order") or source_index + 1)
            for chapter_index, chapter in enumerate(nested_chapters):
                if not isinstance(chapter, dict):
                    continue
                chapter_id = str(chapter.get("chapterId") or chapter.get("id") or "").strip()
                if not chapter_id:
                    continue
                word_count = _optional_nonnegative_int(chapter.get("wordCount"))
                has_content = _optional_has_content(chapter.get("hasContent"), word_count)
                entries.append({
                    "chapterId": chapter_id,
                    "title": str(chapter.get("title") or "").strip(),
                    "volumeId": volume_id,
                    "volumeTitle": volume_title,
                    "volumeOrder": volume_order,
                    "chapterOrder": int(chapter.get("chapterOrder") or chapter.get("order") or chapter_index + 1),
                    "wordCount": word_count,
                    "hasContent": has_content,
                    "sourceIndex": source_index * 1_000_000 + chapter_index,
                })
            continue
        chapter_id = str(item.get("chapterId") or item.get("id") or "").strip()
        if not chapter_id:
            continue
        word_count = _optional_nonnegative_int(item.get("wordCount"))
        has_content = _optional_has_content(item.get("hasContent"), word_count)
        entries.append({
            "chapterId": chapter_id,
            "title": str(item.get("title") or "").strip(),
            "volumeId": str(item.get("volumeId") or "").strip() or None,
            "volumeTitle": str(item.get("volumeTitle") or "").strip(),
            "volumeOrder": int(item.get("volumeOrder") or 0),
            "chapterOrder": int(item.get("chapterOrder") or item.get("order") or 0),
            "wordCount": word_count,
            "hasContent": has_content,
            "sourceIndex": source_index,
        })
    entries.sort(key=lambda item: (item["volumeOrder"], item["chapterOrder"], item["sourceIndex"], item["chapterId"]))
    return entries


def _optional_nonnegative_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _optional_has_content(value: Any, word_count: int | None) -> bool | None:
    if isinstance(value, bool):
        return value
    if word_count is not None:
        return word_count > 0
    return None


def _candidate(entry: dict[str, Any], role: str) -> ResolvedChapterCandidate:
    volume_title = entry.get("volumeTitle") or entry.get("volumeId") or ""
    title = entry.get("title") or entry["chapterId"]
    label = " · ".join(part for part in (volume_title, title) if part)
    return ResolvedChapterCandidate(
        role=role,
        chapterId=entry["chapterId"],
        volumeId=entry.get("volumeId"),
        title=entry.get("title") or None,
        label=label or title,
        wordCount=entry.get("wordCount"),
        hasContent=entry.get("hasContent"),
    )


def _target(entry: dict[str, Any], selector: str, source: str) -> ResolvedIntentTarget:
    volume_title = entry.get("volumeTitle") or entry.get("volumeId") or ""
    title = entry.get("title") or entry["chapterId"]
    label = " · ".join(part for part in (volume_title, title) if part)
    return ResolvedIntentTarget(
        selector=selector,
        chapterId=entry["chapterId"],
        volumeId=entry.get("volumeId"),
        title=entry.get("title") or None,
        label=label or title,
        wordCount=entry.get("wordCount"),
        hasContent=entry.get("hasContent"),
        source=source,
    )


def _last_target(entries: list[dict[str, Any]], selector: str) -> ResolvedIntentTarget:
    structural = entries[-1]
    written_indexes = [index for index, entry in enumerate(entries) if entry.get("hasContent") is True]
    last_written_index = written_indexes[-1] if written_indexes else None
    trailing_entries = (
        [entry for entry in entries[last_written_index + 1:] if entry.get("hasContent") is False]
        if last_written_index is not None
        else [entry for entry in entries if entry.get("hasContent") is False]
    )
    target = _target(structural, selector, "user_message")
    return target.model_copy(update={
        "structuralLast": _candidate(structural, "structural_last"),
        "lastWritten": (
            _candidate(entries[last_written_index], "last_written")
            if last_written_index is not None
            else None
        ),
        "trailingEmptyChapters": [
            _candidate(entry, "trailing_empty")
            for entry in trailing_entries
        ],
    })


def _range_target(entries: list[dict[str, Any]], selector: str) -> ResolvedIntentTarget:
    first = entries[0]
    last = entries[-1]
    first_label = first.get("title") or first["chapterId"]
    last_label = last.get("title") or last["chapterId"]
    volume_ids = {entry.get("volumeId") for entry in entries}
    return ResolvedIntentTarget(
        selector=selector,
        chapterId=first["chapterId"],
        chapterIds=[entry["chapterId"] for entry in entries],
        volumeId=first.get("volumeId") if len(volume_ids) == 1 else None,
        title=first.get("title") or None,
        label=f"{first_label} 至 {last_label}",
        source="user_message",
    )


_CHAPTER_NUMBER = r"[零〇一二两三四五六七八九十百\d]+"
_CHAPTER_RANGE = re.compile(
    rf"第?\s*({_CHAPTER_NUMBER})\s*(?:章)?\s*(?:到|至|—|－|-|~|～)\s*第?\s*({_CHAPTER_NUMBER})\s*章"
)


def _new_chapter_target(message: str, catalog: list[dict[str, Any]]) -> ResolvedIntentTarget | None:
    """Resolve a destination ordinal separately from its existing source anchor.

    Explicit ordinal creation is unambiguous. For the compact Arabic shorthand
    without 第, only the immediate next ordinal outside the supported 1..10
    batch-count range is inferred. Explicit batch/quantity wording stays a count.
    Never turn a missing arbitrary chapter into permission to write the open one.
    """
    from .rules import _is_negated, _mask_non_requested_draft_language
    text = _mask_non_requested_draft_language(message)
    match = re.search(
        rf"(?:新建|新增|创建|新写|开始写|开始创作)\s*(?P<ordinal>第\s*){{1,2}}(?P<number>{_CHAPTER_NUMBER})\s*章",
        text,
    )
    explicit = match is not None
    if not match:
        match = re.search(r"(?:新建|新增|创建)\s*(?P<number>\d+)\s*章", text)
        if not match or re.search(r"(?:连续|批量|一共|总共)", text[:match.end()]):
            return None
    if _is_negated(text, match.start()) or _CHAPTER_RANGE.search(text):
        return None
    prefix = text[:match.start()]
    clause = re.split(r"[，,。；;\n]", prefix)[-1]
    if re.search(r"(?:为什么|怎么|如何|解释|分析|讨论)", clause):
        return None
    if any(prefix.count(left) > prefix.count(right) for left, right in [('“', '”'), ('「', '」'), ('『', '』'), ('《', '》')]) or prefix.count('"') % 2:
        return None
    ordinal = _positive_number(match['number'])
    if not ordinal:
        return None
    if not explicit and ordinal <= 10:
        return None
    if not catalog:
        return ResolvedIntentTarget(selector="new_chapter_ordinal", source="user_message")
    if ordinal != len(catalog) + 1:
        description = (
            f"第{ordinal}章已存在，不能按新章重复创建。"
            if ordinal <= len(catalog)
            else f"当前目录共有{len(catalog)}章，新章应为第{len(catalog) + 1}章，不能直接跳到第{ordinal}章。若指批量数量，请使用“连续新写N章”（每批最多10章）。"
        )
        return ResolvedIntentTarget(selector="new_chapter_ordinal_conflict", label=description, source="user_message")
    anchor = _target(catalog[-1], "new_chapter_ordinal", "user_message")
    return anchor.model_copy(update={"label": f"新建第{ordinal}章（续写锚点：{anchor.label}）"})


def extract_style_work_title(message: str, *, include_project_title: bool = False) -> str | None:
    """Return a quoted work title only when the request is a style extraction.

    Book titles and chapter titles use the same Chinese quotation marks.  A
    style-extraction request such as ``提炼《十日终焉》的文风`` must therefore
    not enter the chapter-target resolver merely because it contains ``《》``.
    """
    # Renderer appends past turns to planning goals for understanding only.
    # A book mentioned in that history must not change this turn's source.
    message = message.split("\n\n会话背景（仅用于理解当前任务）：\n", 1)[0].strip()
    normalized = message.lower()
    source_words = re.sub(r"《[^》]+》", "", normalized)
    source_words = re.sub(
        r"(?:不要|无需|不用|不必|不使用|不读取|忽略|排除)[^，,。；;\n]{0,40}"
        r"(?:当前|本书|本小说|本项目|已导入|已上传)[^，,。；;\n]{0,40}",
        "", source_words,
    )
    if not include_project_title and re.search(
        r"(?:当前|选中|选定|已选择|本书|本小说|本项目|已导入|已上传).{0,40}"
        r"(?:样本|正文|章节|小说|作品)|(?:当前样本|本书|本小说|本项目)|"
        r"(?:提供的|附件中的|导入的|上传的).{0,20}(?:样本|正文|小说|作品)",
        source_words,
    ):
        return None
    style_markers = (
        "提炼文风", "抽取文风", "文风 skill", "语言风格 skill",
        "风格技能包", "style extraction", "writing style skill",
    )
    style_request = any(marker in normalized for marker in style_markers) or bool(re.search(
        r"(?:提炼|抽取).{0,80}(?:文风|语言风格|写作风格)",
        normalized,
    ))
    if not style_request:
        return None
    titles = [item.strip() for item in re.findall(r"《([^》]+)》", message) if item.strip()]
    return titles[-1] if titles else None


def resolve_intent_chapter_target(
    message: str,
    raw_catalog: Any,
    *,
    editor_chapter_id: str | None = None,
    editor_volume_id: str | None = None,
) -> ResolvedIntentTarget | None:
    """Resolve user-facing chapter references against a renderer-provided ordered catalog."""
    message = message.split("\n\n会话背景（仅用于理解当前任务）：\n", 1)[0]
    normalized = message.strip().lower()
    style_work_title = extract_style_work_title(message, include_project_title=True)
    catalog = _normalized_catalog(raw_catalog)
    by_id = {entry["chapterId"]: entry for entry in catalog}
    range_match = _CHAPTER_RANGE.search(normalized)

    creation_target = _new_chapter_target(normalized, catalog)
    if creation_target:
        return creation_target

    if catalog:
        if range_match:
            start = _positive_number(range_match.group(1))
            end = _positive_number(range_match.group(2))
            if start and end and start <= end <= len(catalog):
                return _range_target(catalog[start - 1:end], "novel_chapter_range")

        volume_chapter = re.search(
            r"第\s*([零〇一二两三四五六七八九十百\d]+)\s*卷.{0,8}?第\s*([零〇一二两三四五六七八九十百\d]+)\s*章",
            normalized,
        )
        if volume_chapter:
            volume_ordinal = _positive_number(volume_chapter.group(1))
            chapter_ordinal = _positive_number(volume_chapter.group(2))
            volume_orders = sorted(dict.fromkeys(entry["volumeOrder"] for entry in catalog))
            if volume_ordinal and chapter_ordinal and volume_ordinal <= len(volume_orders):
                volume_order = volume_orders[volume_ordinal - 1]
                volume_entries = [entry for entry in catalog if entry["volumeOrder"] == volume_order]
                if chapter_ordinal <= len(volume_entries):
                    return _target(volume_entries[chapter_ordinal - 1], "volume_chapter_ordinal", "user_message")

        volume_last = re.search(
            r"第\s*([零〇一二两三四五六七八九十百\d]+)\s*卷.{0,6}?(?:最后一章|末章|最终章)",
            normalized,
        )
        if volume_last:
            volume_ordinal = _positive_number(volume_last.group(1))
            volume_orders = sorted(dict.fromkeys(entry["volumeOrder"] for entry in catalog))
            if volume_ordinal and volume_ordinal <= len(volume_orders):
                volume_entries = [entry for entry in catalog if entry["volumeOrder"] == volume_orders[volume_ordinal - 1]]
                if volume_entries:
                    return _last_target(volume_entries, "last_in_volume")

        if re.search(r"(?:当前卷|本卷).{0,6}?(?:最后一章|末章|最终章)", normalized) and editor_volume_id:
            volume_entries = [entry for entry in catalog if entry.get("volumeId") == editor_volume_id]
            if volume_entries:
                return _last_target(volume_entries, "last_in_current_volume")

        if re.search(r"(?:最后一章|末章|最终章|全书最后|整本.{0,3}最后)", normalized):
            return _last_target(catalog, "last_in_novel")

        quoted_titles = [] if style_work_title else [value.strip() for value in re.findall(r"《([^》]+)》", message) if value.strip()]
        title_candidates = [] if style_work_title else quoted_titles or [
            entry["title"]
            for entry in catalog
            if entry["title"] and len(entry["title"]) >= 2 and entry["title"].lower() in normalized
        ]
        for title in title_candidates:
            matches = [entry for entry in catalog if entry["title"].lower() == title.lower()]
            if len(matches) == 1:
                return _target(matches[0], "chapter_title", "user_message")

        chapter_ordinal_match = re.search(
            r"第\s*([零〇一二两三四五六七八九十百\d]+)\s*章",
            normalized,
        )
        if chapter_ordinal_match:
            ordinal = _positive_number(chapter_ordinal_match.group(1))
            if ordinal and ordinal <= len(catalog):
                return _target(catalog[ordinal - 1], "novel_chapter_ordinal", "user_message")

    # Preserve an unresolved explicit selector. Falling back to the editor
    # chapter here would silently turn an intended target into whichever
    # chapter happened to be open when no usable catalog was supplied.
    if range_match:
        return ResolvedIntentTarget(selector="novel_chapter_range", source="user_message")
    if re.search(r"(?:最后一章|末章|最终章|全书最后|整本.{0,3}最后)", normalized):
        return ResolvedIntentTarget(selector="last_in_novel", source="user_message")
    if re.search(rf"第\s*{_CHAPTER_NUMBER}\s*卷", normalized) and re.search(
        rf"第\s*{_CHAPTER_NUMBER}\s*章|最后一章|末章|最终章",
        normalized,
    ):
        return ResolvedIntentTarget(selector="volume_chapter_reference", source="user_message")
    if re.search(rf"第\s*{_CHAPTER_NUMBER}\s*章", normalized):
        if catalog:
            return ResolvedIntentTarget(selector="novel_chapter_ordinal_not_found", source="user_message",
                label=f"当前目录共有{len(catalog)}章，未找到指定章节。若要新增下一章，请明确使用“新建第{len(catalog) + 1}章”。")
        return ResolvedIntentTarget(selector="novel_chapter_ordinal", source="user_message")
    if extract_style_work_title(message):
        # A work title is handled by the style-source workflow. Do not fall
        # through to the open editor chapter and silently replace the source.
        return None
    if not style_work_title and re.findall(r"《([^》]+)》", message):
        return ResolvedIntentTarget(selector="chapter_title", source="user_message")
    if editor_chapter_id and editor_chapter_id in by_id:
        selector = "current_editor_chapter" if re.search(r"(?:当前章|当前章节|这一章|这章|本章)", normalized) else "operation_default"
        source = "current_reference" if selector == "current_editor_chapter" else "operation_default"
        return _target(by_id[editor_chapter_id], selector, source)
    if editor_chapter_id:
        return ResolvedIntentTarget(
            selector="current_editor_chapter",
            chapterId=editor_chapter_id,
            volumeId=editor_volume_id,
            source="current_reference",
        )
    return None
