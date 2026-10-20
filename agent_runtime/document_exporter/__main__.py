from __future__ import annotations

import json
from pathlib import Path
import sys

from .exporter import PROTOCOL, export_document


def main() -> int:
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    job_id = "unknown"

    def emit(payload: dict) -> None:
        print(json.dumps({"protocolVersion": PROTOCOL, "jobId": job_id, **payload}, ensure_ascii=False), flush=True)

    try:
        request = json.load(sys.stdin)
        job_id = str(request["jobId"])
        if request.get("protocolVersion") != PROTOCOL:
            raise ValueError("导出协议版本不匹配")
        directory = Path(request["directory"]).resolve(strict=True)
        # Only fixed task-local names are used; the worker never receives the final target.
        snapshot = json.loads((directory / "snapshot.json").read_text(encoding="utf-8"))
        format = request["format"]
        if format not in ("txt", "docx"):
            raise ValueError("不支持的导出格式")
        result = export_document(snapshot, format, directory / f"output.{format}", lambda n: emit({"type": "progress", "completed": n}))
        emit({"type": "result", "ok": True, **result})
        return 0
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, OSError)) else "文档生成失败，请重试。"
        emit({"type": "result", "ok": False, "code": "GENERATION_FAILED", "message": message})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
