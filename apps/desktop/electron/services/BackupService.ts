import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import { db, PrismaClient } from '@novel-editor/core';
import type { BackupAutoInfo, BackupInspection, BackupMode, BackupOperation, BackupPolicy, BackupProgress, BackupReport } from '../../shared/backup';
import { BackupEngine } from '../backup/BackupEngine';
import { DatasetManager, durableJson } from '../backup/DatasetManager';
import { backupError } from '../backup/BackupRegistry';
import { exclusiveData, dataIdleMilliseconds } from '../backup/MaintenanceGate';
import { fileHash } from '../backup/BackupArchive';
import { retentionPlan } from '../backup/BackupRetention';

export class BackupService {
    private engine?: BackupEngine;
    private barrier: <T>(operation: () => Promise<T>) => Promise<T> = exclusiveData;
    private timer?: ReturnType<typeof setInterval>;
    private busy = false;
    private lastFingerprint = '';
    private policy: BackupPolicy = { enabled: true, lastSuccess: null, lastError: null, intervalMinutes: 15 };
    private pinNames = new Set<string>();
    private waitingSince = Date.now();
    private nextAttemptAt = 0;
    configure(dataset: DatasetManager, schemaVersion: number, barrier: <T>(operation: () => Promise<T>) => Promise<T>, progress: (value: BackupProgress) => void): void {
        this.barrier = barrier;
        this.engine = new BackupEngine({ dataset, database: db as any, createDatabase: file => new PrismaClient({ datasources: { db: { url: `file:${file}` } } }) as any, appVersion: app.getVersion(), schemaVersion, progress });
        void this.engine.cleanupAbandoned().catch(() => undefined);
        const policy = path.join(dataset.userRoot, 'backups', 'policy.json');
        if (fs.existsSync(policy)) {
            try {
                const saved = JSON.parse(fs.readFileSync(policy, 'utf8'));
                this.policy = { ...this.policy, enabled: saved.enabled !== false, lastSuccess: saved.lastSuccess || null, lastError: saved.lastError || null };
                this.pinNames = new Set(Array.isArray(saved.pinned) ? saved.pinned.filter((value: unknown) => typeof value === 'string' && /^auto_backup_[\w-]+\.nebak$/.test(value)) : []);
                this.lastFingerprint = typeof saved.lastFingerprint === 'string' ? saved.lastFingerprint : '';
            } catch { this.policy.lastError = '自动备份配置损坏，已使用默认保护策略；现有备份保留。'; }
        }
        this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 30000);
        this.timer.unref?.();
    }
    private required(): BackupEngine { if (!this.engine) throw backupError('BUSY', '备份服务尚未准备好。'); return this.engine; }
    private get directory(): string { return path.join(this.required().options.dataset.userRoot, 'backups', 'auto'); }
    private async run<T>(operation: () => Promise<T>, kind: BackupOperation): Promise<T> {
        if (this.busy) throw backupError('BUSY', '另一个备份任务正在进行。');
        this.busy = true;
        this.required().begin(kind);
        try { return await this.barrier(operation); }
        catch (error: any) { if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw backupError('CANCELLED', '操作已取消，原资料保留。'); throw error; }
        finally { this.busy = false; this.required().end(); }
    }
    cancel(): boolean { return this.busy && this.required().cancel(); }
    async exportData(targetPath?: string, password?: string): Promise<string | null> {
        if (!targetPath) {
            const result = await dialog.showSaveDialog({ title: '创建完整作品备份', defaultPath: `NovelData_${new Date().toISOString().replace(/[:.]/g, '-')}.nebak`, filters: [{ name: '作品资料备份', extensions: ['nebak'] }] });
            if (result.canceled || !result.filePath) return null;
            targetPath = result.filePath;
        }
        const target = targetPath;
        await this.run(async () => { await this.required().assertIdle(); await this.required().export(target, password); }, 'export');
        return target;
    }
    async inspectData(filePath: string, password?: string): Promise<BackupInspection> {
        return this.run(async () => this.required().inspect(filePath, password), 'inspect');
    }
    async restoreData(inspectionId: string, mode: BackupMode): Promise<void> {
        await this.run(async () => { await this.required().assertIdle(); await this.required().restore(inspectionId, mode); }, 'restore');
    }
    async createAutoBackup(): Promise<string> {
        await fsp.mkdir(this.directory, { recursive: true });
        const target = path.join(this.directory, `auto_backup_${Date.now()}.nebak`);
        await this.exportData(target);
        const stat = await fsp.stat(target);
        await durableJson(`${target}.verified.json`, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: await fileHash(target) });
        this.policy.lastSuccess = new Date().toISOString(); this.policy.lastError = null;
        await this.savePolicy();
        await this.rotate();
        return target;
    }
    private async rotate(): Promise<void> {
        const plan = retentionPlan(await this.getAutoBackups());
        for (const filename of plan.remove) {
            await fsp.unlink(this.autoPath(filename));
            await fsp.rm(`${this.autoPath(filename)}.verified.json`, { force: true });
        }
        this.policy.warning = plan.overBudget ? '自动备份超过 2 GiB；已优先保留最新三份与固定包，请整理备份目录。' : null;
        await this.savePolicy();
    }
    private autoPath(filename: string): string {
        if (!/^auto_backup_[\w-]+\.nebak$/.test(filename)) throw backupError('REFERENCE_INVALID', '备份文件标识无效。');
        return path.join(this.directory, filename);
    }
    async getAutoBackups(): Promise<BackupAutoInfo[]> {
        await fsp.mkdir(this.directory, { recursive: true });
        const result: BackupAutoInfo[] = [];
        for (const filename of await fsp.readdir(this.directory)) {
            if (!/^auto_backup_[\w-]+\.nebak$/.test(filename)) continue;
            const stat = await fsp.lstat(this.autoPath(filename));
            if (stat.isFile() && !stat.isSymbolicLink()) result.push({ filename, createdAt: stat.mtimeMs, size: stat.size, valid: false, pinned: this.pinNames.has(filename) });
        }
        // Files created by this service receive a validation receipt after the
        // archive has been read back. A receipt is invalidated by any file change.
        for (const item of result) {
            const receipt = `${this.autoPath(item.filename)}.verified.json`;
            if (fs.existsSync(receipt)) {
                try { const value = JSON.parse(await fsp.readFile(receipt, 'utf8')); item.valid = value.size === item.size && value.mtimeMs === item.createdAt && value.sha256 === await fileHash(this.autoPath(item.filename)); }
                catch { item.valid = false; }
            }
        }
        return result.sort((a, b) => b.createdAt - a.createdAt);
    }
    async inspectAuto(filename: string, password?: string): Promise<BackupInspection> { return this.inspectData(this.autoPath(filename), password); }
    getPolicy(): BackupPolicy { return { ...this.policy }; }
    async getLastReport(): Promise<BackupReport | null> {
        const file = path.join(this.required().options.dataset.current().root, 'restore-report.json');
        if (!fs.existsSync(file)) return null;
        const value = JSON.parse(await fsp.readFile(file, 'utf8'));
        return { backupId: value.backupId, mode: value.mode, createdAt: value.createdAt, records: value.records, resources: value.resources, warnings: value.warnings, indexesRebuiltAt: value.indexesRebuiltAt, indexMode: value.indexMode };
    }
    async updatePolicy(enabled: boolean): Promise<BackupPolicy> { if (typeof enabled !== 'boolean') throw backupError('REFERENCE_INVALID', '自动保护设置无效。'); this.policy.enabled = enabled; await this.savePolicy(); return this.getPolicy(); }
    async pin(filename: string, pinned: boolean): Promise<void> { await fsp.access(this.autoPath(filename)); if (pinned) this.pinNames.add(filename); else this.pinNames.delete(filename); await this.savePolicy(); }
    private savePolicy(): Promise<void> { return durableJson(path.join(this.required().options.dataset.userRoot, 'backups', 'policy.json'), { ...this.policy, lastFingerprint: this.lastFingerprint, pinned: [...this.pinNames] }); }
    private async tick(): Promise<void> {
        if (!this.busy) await this.required().cleanExpired();
        if (!this.policy.enabled || this.busy || Date.now() < this.nextAttemptAt || Date.now() - new Date(this.policy.lastSuccess || 0).getTime() < this.policy.intervalMinutes * 60000) return;
        try {
            if (Date.now() - this.waitingSince > 60 * 60000) this.policy.warning = '尚未形成新备份：正在等待连续空闲与 Agent 任务结束。';
            if (dataIdleMilliseconds() < 30000) return;
            await this.required().assertIdle();
            const fingerprint = await this.required().fingerprint();
            if (fingerprint === this.lastFingerprint) return;
            await this.createAutoBackup();
            this.lastFingerprint = fingerprint;
            this.waitingSince = Date.now();
            await this.savePolicy();
        } catch (error: any) {
            if (error.code !== 'BUSY') { this.nextAttemptAt = Date.now() + (error.code === 'CANCELLED' ? 15 : 5) * 60000; this.policy.lastError = error.message || '自动备份失败'; await this.savePolicy(); }
        }
    }
    stop(): void { if (this.timer) clearInterval(this.timer); void this.engine?.dispose().catch(() => undefined); }
}
export const backupService = new BackupService();
