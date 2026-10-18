import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupError } from './BackupRegistry';
import { safeChild, fileHash } from './BackupArchive';

export interface DatasetLocation { id: string | null; root: string; databasePath: string }
export async function validateActivationResources(location: DatasetLocation): Promise<void> {
    const ready = JSON.parse(await fsp.readFile(path.join(location.root, 'ready.json'), 'utf8'));
    if (ready.generationId !== location.id) throw backupError('ACTIVATION_FAILED', '候选数据集完成标记无效。');
    const resources = JSON.parse(await fsp.readFile(path.join(location.root, 'activation-resources.json'), 'utf8'));
    if (!Array.isArray(resources)) throw backupError('ACTIVATION_FAILED', '恢复资源校验清单无效。');
    for (const resource of resources) {
        const file = safeChild(location.root, resource.name);
        if ((await fsp.stat(file)).size !== resource.size || await fileHash(file) !== resource.hash) throw backupError('ACTIVATION_FAILED', '候选图片资源校验失败。');
    }
}
export async function durableJson(file: string, value: unknown): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
        try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
        await fsp.rename(temporary, file);
        if (process.platform !== 'win32') { const directory = await fsp.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await fsp.rm(temporary, { force: true }); }
}
export class DatasetManager {
    constructor(readonly userRoot: string, readonly legacyDatabasePath: string) {}
    private get pointer(): string { return path.join(this.userRoot, 'active-dataset.json'); }
    private get journal(): string { return path.join(this.userRoot, 'recovery', 'pending-restore.json'); }
    location(id: string | null): DatasetLocation {
        if (id === null) return { id, root: this.userRoot, databasePath: this.legacyDatabasePath };
        if (!/^[a-f0-9-]{36}$/.test(id)) throw backupError('ACTIVATION_FAILED', '数据集标识无效。');
        const root = safeChild(this.userRoot, `datasets/${id}`);
        return { id, root, databasePath: path.join(root, 'novel_editor.db') };
    }
    current(): DatasetLocation {
        if (!fs.existsSync(this.pointer)) return this.location(null);
        const value = JSON.parse(fs.readFileSync(this.pointer, 'utf8'));
        return this.location(value.generationId);
    }
    async candidate(): Promise<DatasetLocation> {
        const location = this.location(randomUUID());
        await fsp.mkdir(location.root, { recursive: true, mode: 0o700 });
        return location;
    }
    async activate(next: DatasetLocation, rollbackPath: string): Promise<void> {
        const previous = this.current();
        await durableJson(path.join(next.root, 'ready.json'), { generationId: next.id, createdAt: new Date().toISOString() });
        await durableJson(this.journal, { version: 1, previous: previous.id, next: next.id, rollbackPath, phase: 'prepared' });
        await durableJson(this.pointer, { generationId: next.id });
        await durableJson(this.journal, { version: 1, previous: previous.id, next: next.id, rollbackPath, phase: 'activated' });
    }
    async recover(validate: (location: DatasetLocation, activationCheck?: boolean) => Promise<void>): Promise<void> {
        if (!fs.existsSync(this.journal)) {
            const current = this.current();
            if (current.id) await validate(current);
            return;
        }
        const journal = JSON.parse(await fsp.readFile(this.journal, 'utf8'));
        if (journal.version !== 1) throw backupError('ROLLBACK_FAILED', '恢复日志版本不受支持。');
        const next = this.location(journal.next), previous = this.location(journal.previous);
        if (this.current().id === next.id) {
            try { await validate(next, true); } catch {
                await durableJson(this.pointer, { generationId: previous.id });
                await validate(previous);
            }
        } else { await validate(previous); }
        // Acknowledge only after the caller has opened its stores and resources.
        // A second crash during startup must still find this journal.
    }
    async finishRecovery(): Promise<void> {
        if (!fs.existsSync(this.journal)) return;
        const journal = JSON.parse(await fsp.readFile(this.journal, 'utf8'));
        this.location(journal.next);
        await fsp.rename(this.journal, path.join(this.userRoot, 'recovery', `${journal.next}-completed.json`));
    }
    async rollbackPending(): Promise<boolean> {
        if (!fs.existsSync(this.journal)) return false;
        const journal = JSON.parse(await fsp.readFile(this.journal, 'utf8'));
        if (journal.version !== 1 || this.current().id !== this.location(journal.next).id) return false;
        const previous = this.location(journal.previous);
        if (!fs.existsSync(previous.databasePath)) throw backupError('ROLLBACK_FAILED', '恢复前数据库缺失，请保留安全快照并手动恢复。');
        await durableJson(this.pointer, { generationId: previous.id });
        await durableJson(this.journal, { ...journal, phase: 'rolled_back' });
        return true;
    }
}
