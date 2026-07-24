import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import crypto from 'crypto';
import { db } from '@novel-editor/core';
import { app, dialog } from 'electron';

interface BackupManifest {
    version: number;
    appVersion: string;
    createdAt: string;
    platform: string;
    encrypted: boolean;
    encryption?: {
        algo: string;
        salt: string;
        iv: string;
        authTag: string;
    };
}

export interface AutoBackupInfo {
    filename: string;
    createdAt: number;
    size: number;
}

export class BackupService {
    private getBackupDir(): string {
        return path.join(app.getPath('userData'), 'backups');
    }

    private getAutoBackupDir(): string {
        return path.join(this.getBackupDir(), 'auto');
    }

    private ensureBackupDirs(): void {
        const backupDir = this.getBackupDir();
        const autoBackupDir = this.getAutoBackupDir();

        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        if (!fs.existsSync(autoBackupDir)) fs.mkdirSync(autoBackupDir, { recursive: true });
    }

    // --- Encryption Helpers ---

    private deriveKey(password: string, salt: Buffer): Buffer {
        return crypto.pbkdf2Sync(password, salt as any, 100000, 32, 'sha256');
    }

    private encryptData(data: Buffer, password: string): { encryptedData: Buffer; salt: string; iv: string; authTag: string } {
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        const key = this.deriveKey(password, salt);

        // Cast to any to bypass strict Buffer/Uint8Array type mismatch in Electron environment
        const cipher = crypto.createCipheriv('aes-256-gcm', key as any, iv as any);
        const encrypted = Buffer.concat([cipher.update(data as any), cipher.final()] as any);
        const authTag = cipher.getAuthTag();

        return {
            encryptedData: encrypted,
            salt: salt.toString('hex'),
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex')
        };
    }

    private decryptData(encryptedData: Buffer, password: string, encryption: NonNullable<BackupManifest['encryption']>): Buffer {
        const salt = Buffer.from(encryption.salt, 'hex');
        const iv = Buffer.from(encryption.iv, 'hex');
        const authTag = Buffer.from(encryption.authTag, 'hex');
        const key = this.deriveKey(password, salt);

        // Cast to any to bypass strict Buffer/Uint8Array type mismatch
        const decipher = crypto.createDecipheriv('aes-256-gcm', key as any, iv as any);
        decipher.setAuthTag(authTag as any);

        return Buffer.concat([decipher.update(encryptedData as any), decipher.final()] as any);
    }

    // --- Core Logic ---

    // 1. Export Data
    async exportData(targetPath?: string, password?: string): Promise<string> {
        // Fetch all data
        // Order doesn't matter for JSON export, but maintaining a structure helps
        const [novels, volumes, chapters, characters, ideas, tags] = await Promise.all([
            db.novel.findMany(),
            db.volume.findMany(),
            db.chapter.findMany(),
            db.character.findMany(),
            db.idea.findMany(),
            db.tag.findMany()
        ]);

        const fullData = { novels, volumes, chapters, characters, ideas, tags };
        const dataBuffer = Buffer.from(JSON.stringify(fullData));

        const zip = new AdmZip();

        // Manifest
        const manifest: BackupManifest = {
            version: 1,
            appVersion: app.getVersion(),
            createdAt: new Date().toISOString(),
            platform: process.platform,
            encrypted: !!password
        };

        if (password) {
            const { encryptedData, salt, iv, authTag } = this.encryptData(dataBuffer, password);
            manifest.encryption = { algo: 'aes-256-gcm', salt, iv, authTag };
            zip.addFile('data.bin', encryptedData);
        } else {
            zip.addFile('data.json', dataBuffer);
        }

        zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

        if (!targetPath) {
            const { filePath } = await dialog.showSaveDialog({
                title: 'Export Backup',
                defaultPath: `NovelData_${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_')}.nebak`,
                filters: [{ name: 'CloudDream Novel Agent Backup', extensions: ['nebak'] }]
            });
            if (!filePath) throw new Error('Export cancelled');
            targetPath = filePath;
        }

        zip.writeZip(targetPath);
        return targetPath;
    }

    // 2. Import Data (Restore)
    async importData(filePath: string, password?: string): Promise<void> {
        const zip = new AdmZip(filePath);
        const manifestEntry = zip.getEntry('manifest.json');

        if (!manifestEntry) throw new Error('Invalid backup file: manifest.json missing');
        const manifest: BackupManifest = JSON.parse(manifestEntry.getData().toString('utf8'));

        let dataJson: any;

        if (manifest.encrypted) {
            if (!password) throw new Error('PASSWORD_REQUIRED'); // Specific error code for frontend

            const dataEntry = zip.getEntry('data.bin');
            if (!dataEntry) throw new Error('Invalid backup file: data.bin missing');
            if (!manifest.encryption) throw new Error('Invalid backup file: encryption metadata missing');

            try {
                const decrypted = this.decryptData(dataEntry.getData(), password, manifest.encryption);
                dataJson = JSON.parse(decrypted.toString('utf8'));
            } catch (e) {
                throw new Error('PASSWORD_INVALID');
            }
        } else {
            const dataEntry = zip.getEntry('data.json');
            if (!dataEntry) throw new Error('Invalid backup file: data.json missing');
            dataJson = JSON.parse(dataEntry.getData().toString('utf8'));
        }

        // --- Perform Restore ---
        await this.performRestore(dataJson);
    }

    // Helper: Perform Restore (Transactional)
    private async performRestore(data: any): Promise<void> {
        // 1. Create Auto-Backup of current state before nuking
        await this.createAutoBackup();

        // 2. Transactional Restore
        // Note: $transaction is interactive, ensuring atomicity
        await db.$transaction(async (tx) => {
            // Delete all existing data
            // Order matters for FK constraints: Tag/Idea -> Chapter -> Volume -> Novel
            // But Prisma usually handles basic deletions? To be safe, delete from child to parent
            // Actually, with onDelete: Cascade, deleting Novel might clear everything, 
            // but we also have standalone tags or cross-relations.
            // Safest: Delete all explicitly.
            await tx.tag.deleteMany();
            await tx.idea.deleteMany();
            await tx.character.deleteMany();
            await tx.chapter.deleteMany();
            await tx.volume.deleteMany();
            await tx.novel.deleteMany();

            // Insert new data
            // SQLite does not support createMany, use loop instead
            if (data.novels?.length) for (const item of data.novels) await tx.novel.create({ data: item });
            if (data.volumes?.length) for (const item of data.volumes) await tx.volume.create({ data: item });
            if (data.chapters?.length) for (const item of data.chapters) await tx.chapter.create({ data: item });
            if (data.characters?.length) for (const item of data.characters) await tx.character.create({ data: item });
            if (data.ideas?.length) for (const item of data.ideas) await tx.idea.create({ data: item });
            if (data.tags?.length) for (const item of data.tags) await tx.tag.create({ data: item });
        }, {
            maxWait: 10000,
            timeout: 20000
        });
    }

    // 3. Auto Backup Logic
    async createAutoBackup() {
        try {
            this.ensureBackupDirs();
            const timestamp = Date.now();
            const filename = `auto_backup_${timestamp}.nebak`;
            const filePath = path.join(this.getAutoBackupDir(), filename);

            // Re-use exportData logic but to specific path without password
            await this.exportData(filePath);
            console.log('[BackupService] Auto-backup created:', filename);

            // Rotate
            await this.rotateAutoBackups();
        } catch (e) {
            console.error('[BackupService] Failed to create auto-backup:', e);
        }
    }

    private async rotateAutoBackups() {
        this.ensureBackupDirs();
        const autoBackupDir = this.getAutoBackupDir();
        const files = fs.readdirSync(autoBackupDir)
            .filter(f => f.endsWith('.nebak'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(autoBackupDir, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time); // Newest first

        // Keep 3
        const toDelete = files.slice(3);
        for (const file of toDelete) {
            fs.unlinkSync(path.join(autoBackupDir, file.name));
            console.log('[BackupService] Rotated auto-backup:', file.name);
        }
    }

    // 4. List Auto Backups
    async getAutoBackups(): Promise<AutoBackupInfo[]> {
        this.ensureBackupDirs();
        const autoBackupDir = this.getAutoBackupDir();
        return fs.readdirSync(autoBackupDir)
            .filter(f => f.endsWith('.nebak'))
            .map(f => {
                const stats = fs.statSync(path.join(autoBackupDir, f));
                return {
                    filename: f,
                    createdAt: stats.mtime.getTime(),
                    size: stats.size
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    // 5. Restore from Auto Backup
    async restoreAutoBackup(filename: string): Promise<void> {
        this.ensureBackupDirs();
        const filePath = path.join(this.getAutoBackupDir(), filename);
        if (!fs.existsSync(filePath)) throw new Error('Backup file not found');

        // Use standard importData logic (no password for auto backups)
        await this.importData(filePath);
    }
}

export const backupService = new BackupService();
