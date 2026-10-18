"""User-facing failures for local infrastructure, independent of model errors."""
from __future__ import annotations

import errno
import sqlite3
from typing import Any


def storage_failure(error: BaseException) -> dict[str, Any] | None:
    sqlite_code = getattr(error, "sqlite_errorcode", None)
    primary = sqlite_code & 255 if isinstance(sqlite_code, int) else None
    text = str(error).lower()
    explicit_code = getattr(error, "code", None)
    if isinstance(explicit_code, str) and explicit_code.startswith("STORAGE_"):
        text = f"{explicit_code.lower()} {text}"
    filesystem_error = isinstance(error, OSError) and getattr(error, "errno", None) in {
        errno.ENOSPC, errno.EACCES, errno.EPERM, errno.EROFS, errno.EIO, errno.ENOENT,
    }
    if not isinstance(error, sqlite3.Error) and not filesystem_error and not any(word in text for word in (
        "database or disk is full", "sqlite_full", "no space left", "database is locked", "readonly database", "storage_",
        "database disk image is malformed", "disk i/o error",
    )):
        return None
    if primary == sqlite3.SQLITE_FULL or getattr(error, "errno", None) == errno.ENOSPC or any(word in text for word in ("disk is full", "no space left", "sqlite_full", "storage_disk_full")):
        code, message = "STORAGE_DISK_FULL", "存储空间不足，任务已停止。请释放应用数据所在磁盘的空间，再检查任务状态；不要重复启动任务。"
    elif primary in {sqlite3.SQLITE_READONLY, sqlite3.SQLITE_PERM, sqlite3.SQLITE_AUTH} or getattr(error, "errno", None) in {errno.EACCES, errno.EPERM} or "readonly database" in text or "storage_permission_denied" in text:
        code, message = "STORAGE_PERMISSION_DENIED", "无法写入应用数据，任务已停止。请检查数据目录权限或文件占用，再检查任务状态。"
    elif primary in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED} or "database is locked" in text or "storage_busy" in text:
        code, message = "STORAGE_BUSY", "应用数据库读写繁忙，暂时无法保存执行结果，任务已停止。已完成结果保留，请稍后检查原任务的恢复入口；持续出现时再检查其他程序或应用实例的占用。"
    elif primary in {sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB} or "database disk image is malformed" in text or "storage_corrupt" in text:
        code, message = "STORAGE_CORRUPT", "应用数据损坏，任务已停止。请保留现有文件并检查或恢复备份，不要删除数据库后重跑。"
    else:
        code, message = "STORAGE_UNAVAILABLE", "应用数据读写失败，任务已停止。请检查磁盘、数据路径与文件权限，再检查任务状态。"
    return {"code": code, "message": message, "retryable": False, "persistenceFailed": True}
