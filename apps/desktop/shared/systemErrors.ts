/** Local infrastructure errors must not be presented as invalid model input. */
export function storageErrorMessage(error: unknown): string | null {
    const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null;
    const text = `${String(record?.code ?? '')} ${error instanceof Error ? error.message : String(record?.message ?? error ?? '')}`;
    if (/STORAGE_DISK_FULL|database or disk is full|SQLITE_FULL|no space left|disk is full/i.test(text)) {
        return '应用数据所在磁盘空间不足。请释放空间，再检查任务状态；不要直接重复启动任务。';
    }
    if (/STORAGE_PERMISSION_DENIED|readonly database|SQLITE_READONLY/i.test(text)) {
        return '无法写入应用数据。请检查数据目录权限和文件占用，再检查任务状态。';
    }
    if (/STORAGE_BUSY|database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(text)) {
        return '应用数据库读写繁忙，暂时无法保存执行结果。已完成结果保留，请稍后检查原任务的恢复入口；持续出现时再检查其他程序或应用实例的占用。';
    }
    if (/STORAGE_CORRUPT|database disk image is malformed|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(text)) {
        return '应用数据损坏。请保留现有文件并检查或恢复备份。';
    }
    if (/STORAGE_UNAVAILABLE|SQLITE_IOERR|disk I\/O error/i.test(text)) {
        return '应用数据读写失败。请检查磁盘、数据路径与文件权限。';
    }
    return null;
}
