from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import re
from typing import Any, Iterable

from charset_normalizer import from_bytes


PROTOCOL_VERSION = "document-extractor-v1"
SUPPORTED_EXTENSIONS = {".txt", ".md", ".markdown", ".docx", ".pdf"}
DEFAULT_MAX_CHARACTERS = 2_000_000


class DocumentExtractorError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class SourceBlock:
    type: str
    text: str
    page: int | None = None
    heading_path: tuple[str, ...] = ()


def _clean_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\u0000", "")
    return "\n".join(line.rstrip() for line in value.split("\n")).strip()


def _stable_block_id(index: int, block: SourceBlock) -> str:
    identity = "\u001f".join((str(index), block.type, block.text, *block.heading_path))
    return f"blk_{sha256(identity.encode('utf-8')).hexdigest()[:20]}"


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _truncate_utf16(value: str, max_units: int) -> str:
    if max_units <= 0:
        return ""
    used = 0
    end = 0
    for end, char in enumerate(value, start=1):
        used += 2 if ord(char) > 0xFFFF else 1
        if used > max_units:
            return value[: end - 1]
    return value


def _assemble(blocks: Iterable[SourceBlock], max_characters: int) -> tuple[str, list[dict[str, Any]], bool]:
    plain_parts: list[str] = []
    output_blocks: list[dict[str, Any]] = []
    offset = 0
    truncated = False
    for source_index, source in enumerate(blocks):
        text = _clean_text(source.text)
        if not text:
            continue
        separator = "\n\n" if plain_parts else ""
        separator_length = _utf16_length(separator)
        remaining = max_characters - offset - separator_length
        if remaining <= 0:
            truncated = True
            break
        text_length = _utf16_length(text)
        if text_length > remaining:
            text = _truncate_utf16(text, remaining).rstrip()
            text_length = _utf16_length(text)
            truncated = True
        start = offset + separator_length
        end = start + text_length
        plain_parts.append(f"{separator}{text}")
        block: dict[str, Any] = {
            "blockId": _stable_block_id(source_index, SourceBlock(source.type, text, source.page, source.heading_path)),
            "type": source.type,
            "text": text,
            "startOffset": start,
            "endOffset": end,
        }
        if source.page is not None:
            block["page"] = source.page
        if source.heading_path:
            block["headingPath"] = list(source.heading_path)
        output_blocks.append(block)
        offset = end
        if truncated:
            break
    return "".join(plain_parts), output_blocks, truncated


def _decode_text(path: Path) -> tuple[str, str | None]:
    raw = path.read_bytes()
    if not raw:
        return "", None
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16"), "utf-16"
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "utf-8-sig"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        match = from_bytes(raw).best()
        if match is None:
            raise DocumentExtractorError("TEXT_EXTRACTION_FAILED", "Unable to detect the text encoding")
        return str(match), match.encoding


def _text_blocks(text: str, markdown: bool) -> tuple[list[SourceBlock], str | None]:
    blocks: list[SourceBlock] = []
    heading_stack: list[str] = []
    title: str | None = None
    paragraphs = re.split(r"\n\s*\n", _clean_text(text))
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        heading_match = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", paragraph) if markdown else None
        if heading_match:
            level = len(heading_match.group(1))
            heading = heading_match.group(2).strip()
            heading_stack[level - 1:] = [heading]
            heading_stack[:] = heading_stack[:level]
            title = title or heading
            blocks.append(SourceBlock("heading", heading, heading_path=tuple(heading_stack)))
            continue
        block_type = "list_item" if markdown and re.match(r"^(?:[-*+] |\d+[.)] )", paragraph) else "paragraph"
        blocks.append(SourceBlock(block_type, paragraph, heading_path=tuple(heading_stack)))
    return blocks, title


def _docx_blocks(path: Path) -> tuple[list[SourceBlock], dict[str, Any]]:
    try:
        from docx import Document
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as error:
        raise DocumentExtractorError("EXTRACTOR_UNAVAILABLE", "DOCX extraction support is unavailable") from error

    document = Document(str(path))
    blocks: list[SourceBlock] = []
    heading_stack: list[str] = []
    for child in document.element.body.iterchildren():
        if child.tag.endswith("}p"):
            paragraph = Paragraph(child, document)
            text = _clean_text(paragraph.text)
            if not text:
                continue
            style_name = paragraph.style.name if paragraph.style is not None else ""
            heading_match = re.match(r"Heading\s+(\d+)", style_name, re.IGNORECASE)
            if heading_match:
                level = max(1, min(6, int(heading_match.group(1))))
                heading_stack[level - 1:] = [text]
                heading_stack[:] = heading_stack[:level]
                blocks.append(SourceBlock("heading", text, heading_path=tuple(heading_stack)))
            else:
                is_list = bool(paragraph._p.pPr is not None and paragraph._p.pPr.numPr is not None)
                blocks.append(SourceBlock("list_item" if is_list else "paragraph", text, heading_path=tuple(heading_stack)))
        elif child.tag.endswith("}tbl"):
            table = Table(child, document)
            rows = ["\t".join(_clean_text(cell.text) for cell in row.cells) for row in table.rows]
            text = "\n".join(row for row in rows if row.strip())
            if text:
                blocks.append(SourceBlock("table", text, heading_path=tuple(heading_stack)))
    properties = document.core_properties
    return blocks, {
        "title": _clean_text(properties.title or "") or None,
        "author": _clean_text(properties.author or "") or None,
    }


def _pdf_blocks(path: Path) -> tuple[list[SourceBlock], dict[str, Any]]:
    try:
        import fitz
    except ImportError as error:
        raise DocumentExtractorError("EXTRACTOR_UNAVAILABLE", "PDF extraction support is unavailable") from error

    blocks: list[SourceBlock] = []
    with fitz.open(path) as document:
        metadata = document.metadata or {}
        for page_index, page in enumerate(document, start=1):
            page_blocks = sorted(page.get_text("blocks"), key=lambda item: (round(item[1], 1), round(item[0], 1)))
            for item in page_blocks:
                text = _clean_text(str(item[4]))
                if text:
                    blocks.append(SourceBlock("paragraph", text, page=page_index))
        if not blocks:
            raise DocumentExtractorError("OCR_REQUIRED", "The PDF contains no extractable text")
        return blocks, {
            "title": _clean_text(str(metadata.get("title") or "")) or None,
            "author": _clean_text(str(metadata.get("author") or "")) or None,
            "pageCount": document.page_count,
        }


def extract_document(request: dict[str, Any]) -> dict[str, Any]:
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise DocumentExtractorError("EXTRACTOR_PROTOCOL_ERROR", "Unsupported document extractor protocol")
    path_value = request.get("temporaryFilePath")
    if not isinstance(path_value, str) or not path_value:
        raise DocumentExtractorError("INVALID_INPUT", "temporaryFilePath is required")
    path = Path(path_value).resolve()
    if not path.is_file():
        raise DocumentExtractorError("FILE_READ_FAILED", "The selected document is unavailable")

    extension = str(request.get("extension") or path.suffix).lower()
    if not extension.startswith("."):
        extension = f".{extension}"
    if extension not in SUPPORTED_EXTENSIONS:
        raise DocumentExtractorError("UNSUPPORTED_FILE_TYPE", f"Unsupported document type: {extension}")
    limits = request.get("limits") if isinstance(request.get("limits"), dict) else {}
    max_characters = int(limits.get("maxCharacters") or DEFAULT_MAX_CHARACTERS)
    if max_characters < 1 or max_characters > DEFAULT_MAX_CHARACTERS:
        raise DocumentExtractorError("INVALID_INPUT", "maxCharacters is outside the allowed range")

    metadata: dict[str, Any] = {"warnings": []}
    if extension in {".txt", ".md", ".markdown"}:
        decoded, encoding = _decode_text(path)
        source_blocks, title = _text_blocks(decoded, extension in {".md", ".markdown"})
        metadata["encoding"] = encoding
    elif extension == ".docx":
        source_blocks, document_metadata = _docx_blocks(path)
        title = document_metadata.pop("title", None)
        metadata.update({key: value for key, value in document_metadata.items() if value is not None})
    else:
        source_blocks, document_metadata = _pdf_blocks(path)
        title = document_metadata.pop("title", None)
        metadata.update({key: value for key, value in document_metadata.items() if value is not None})

    plain_text, blocks, truncated = _assemble(source_blocks, max_characters)
    if not plain_text.strip():
        raise DocumentExtractorError("EMPTY_DOCUMENT", "The document contains no readable text")
    if truncated:
        metadata["warnings"].append({
            "code": "CONTENT_TRUNCATED",
            "message": f"Content exceeded the {max_characters} character limit",
        })
    return {
        **({"title": title} if title else {}),
        "plainText": plain_text,
        "blocks": blocks,
        "metadata": metadata,
    }
