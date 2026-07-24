from __future__ import annotations

import json
import sys
from typing import Any

from .extractor import DocumentExtractorError, extract_document


def _configure_stdio() -> None:
    # Electron exchanges protocol messages as UTF-8 regardless of the Windows code page.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")


def _error_payload(job_id: str, error: Exception) -> dict[str, Any]:
    if isinstance(error, DocumentExtractorError):
        return {
            "protocolVersion": "document-extractor-v1",
            "jobId": job_id,
            "ok": False,
            "error": {"code": error.code, "message": error.message},
        }
    return {
        "protocolVersion": "document-extractor-v1",
        "jobId": job_id,
        "ok": False,
        "error": {"code": "TEXT_EXTRACTION_FAILED", "message": "Document extraction failed"},
    }


def main() -> int:
    _configure_stdio()
    job_id = "unknown"
    try:
        request = json.load(sys.stdin)
        job_id = str(request.get("jobId") or job_id)
        result = extract_document(request)
        payload = {
            "protocolVersion": "document-extractor-v1",
            "jobId": job_id,
            "ok": True,
            "document": result,
        }
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        print(json.dumps(_error_payload(job_id, error), ensure_ascii=False, separators=(",", ":")), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
