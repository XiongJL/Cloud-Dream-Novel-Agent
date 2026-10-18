export type BackupMode = 'copy' | 'replace_all';
export type BackupOperation = 'export' | 'inspect' | 'restore';
export type BackupPhase = 'preparing' | 'snapshotting' | 'packaging' | 'verifying' | 'inspecting' | 'staging' | 'committing' | 'completed' | 'failed';
export interface BackupProgress { phase: BackupPhase; completed: number; total?: number; message: string; operation?: BackupOperation }
export interface BackupInspection {
    inspectionId: string;
    formatVersion: number;
    createdAt: string;
    completeness: 'complete' | 'legacy_incomplete';
    novels: Array<{ id: string; title: string; chapters: number }>;
    records: number;
    resources: number;
    warnings: string[];
    allowedModes: BackupMode[];
}
export interface BackupResult { success: boolean; code?: string; message?: string; inspection?: BackupInspection; path?: string }
export interface BackupAutoInfo { filename: string; createdAt: number; size: number; valid: boolean; pinned: boolean }
export interface BackupPolicy { enabled: boolean; lastSuccess: string | null; lastError: string | null; intervalMinutes: number; warning?: string | null }
export interface BackupReport { backupId: string; mode: BackupMode; createdAt: string; records: number; resources: number; warnings: string[]; indexesRebuiltAt?: string; indexMode?: string }
export interface BackupAPI {
    cancel(): Promise<boolean>;
    export(password?: string): Promise<BackupResult>;
    inspect(password?: string, filename?: string): Promise<BackupResult>;
    restore(inspectionId: string, mode: BackupMode): Promise<BackupResult>;
    getAutoBackups(): Promise<BackupAutoInfo[]>;
    getPolicy(): Promise<BackupPolicy>;
    getLastReport(): Promise<BackupReport | null>;
    openDirectory(): Promise<void>;
    updatePolicy(enabled: boolean): Promise<BackupPolicy>;
    pin(filename: string, pinned: boolean): Promise<void>;
    onProgress(callback: (progress: BackupProgress) => void): () => void;
    onFlush(callback: () => Promise<void>): () => void;
    onMaintenance(callback: (busy: boolean) => void): () => void;
}
