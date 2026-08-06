import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClientType } from '@novel-editor/core';

// Version 0 was used by the pre-migration development builds. Those databases
// are archived and recreated once. Every later version must have a registered
// migration and is upgraded in place.
export const DATABASE_SCHEMA_VERSION = 2;

type ProbeClient = Pick<PrismaClientType, '$queryRawUnsafe' | '$executeRawUnsafe' | '$disconnect'>;

export interface DatabasePreparationResult {
    reset: boolean;
    previousVersion: number | null;
    archiveDirectory: string | null;
    reason: 'new' | 'current' | 'upgrade' | 'incompatible' | 'unreadable';
    probeError?: string;
}

export interface DatabaseMigration {
    version: number;
    name: string;
    checksum: string;
    up: (database: MigrationDatabase) => Promise<void>;
}

export type MigrationDatabase = Pick<PrismaClientType, '$queryRawUnsafe' | '$executeRawUnsafe'>;

interface PrepareDatabaseOptions {
    databasePath: string;
    userDataPath: string;
    createProbeClient: () => ProbeClient;
    expectedVersion?: number;
}

function validateSchemaVersion(version: number): number {
    if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`Invalid database schema version: ${version}`);
    }
    return version;
}

function normalizePragmaInteger(value: unknown): number {
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return 0;
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function archiveDatabaseFiles(
    databasePath: string,
    userDataPath: string,
    previousVersion: number | null,
): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const versionLabel = previousVersion === null ? 'unknown' : String(previousVersion);
    const archiveDirectory = path.join(
        userDataPath,
        'backups',
        'database-resets',
        `${timestamp}-schema-v${versionLabel}-${randomUUID().slice(0, 8)}`,
    );
    await fs.mkdir(archiveDirectory, { recursive: true });

    const sourcePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    const moved: Array<{ source: string; target: string }> = [];
    try {
        for (const source of sourcePaths) {
            if (!(await pathExists(source))) continue;
            const target = path.join(archiveDirectory, path.basename(source));
            await fs.rename(source, target);
            moved.push({ source, target });
        }
    } catch (error) {
        for (const entry of moved.reverse()) {
            try {
                await fs.rename(entry.target, entry.source);
            } catch {
                // The original error remains the most useful failure to report.
            }
        }
        const wrapped = new Error(`Failed to archive incompatible database at ${databasePath}`);
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
    }

    return archiveDirectory;
}

export async function prepareDatabaseForSchema(
    options: PrepareDatabaseOptions,
): Promise<DatabasePreparationResult> {
    const expectedVersion = validateSchemaVersion(options.expectedVersion ?? DATABASE_SCHEMA_VERSION);
    if (!(await pathExists(options.databasePath))) {
        return {
            reset: false,
            previousVersion: null,
            archiveDirectory: null,
            reason: 'new',
        };
    }

    const client = options.createProbeClient();
    let previousVersion: number | null = null;
    let probeError: string | undefined;
    try {
        const rows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA user_version');
        previousVersion = normalizePragmaInteger(rows[0]?.user_version);
        if (previousVersion !== expectedVersion) {
            await client.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        }
    } catch (error) {
        previousVersion = null;
        probeError = error instanceof Error ? error.message : String(error);
    } finally {
        await client.$disconnect().catch(() => undefined);
    }

    if (previousVersion !== null && previousVersion > expectedVersion) {
        throw new Error(
            `Database schema v${previousVersion} is newer than this app supports (v${expectedVersion}). ` +
            'Install a newer app version instead of resetting the database.',
        );
    }
    if (previousVersion === expectedVersion || (previousVersion !== null && previousVersion > 0)) {
        return {
            reset: false,
            previousVersion,
            archiveDirectory: null,
            reason: previousVersion === expectedVersion ? 'current' : 'upgrade',
        };
    }

    const archiveDirectory = await archiveDatabaseFiles(
        options.databasePath,
        options.userDataPath,
        previousVersion,
    );
    return {
        reset: true,
        previousVersion,
        archiveDirectory,
        reason: probeError ? 'unreadable' : 'incompatible',
        ...(probeError ? { probeError } : {}),
    };
}

async function createMigrationSnapshot(
    database: PrismaClientType,
    databasePath: string,
    userDataPath: string,
    fromVersion: number,
    toVersion: number,
): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotDirectory = path.join(userDataPath, 'backups', 'database-migrations');
    const databaseName = path.parse(databasePath).name;
    const snapshotPath = path.join(snapshotDirectory, `${databaseName}-${timestamp}-v${fromVersion}-to-v${toVersion}.db`);
    await fs.mkdir(snapshotDirectory, { recursive: true });
    const escapedPath = snapshotPath.replace(/'/g, "''");
    await database.$executeRawUnsafe(`VACUUM INTO '${escapedPath}'`);
    return snapshotPath;
}

export interface DatabaseMigrationResult {
    fromVersion: number;
    toVersion: number;
    applied: string[];
    snapshotPath: string | null;
}

const MIGRATION_LEDGER_TABLE = 'AppSchemaMigration';
const BASELINE_CHECKSUM = 'bundled-schema-v1';

function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

async function ensureMigrationLedger(database: MigrationDatabase): Promise<void> {
    await database.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
            version INTEGER NOT NULL PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function recordMigration(database: MigrationDatabase, migration: Pick<DatabaseMigration, 'version' | 'name' | 'checksum'>): Promise<void> {
    await database.$executeRawUnsafe(`
        INSERT INTO ${MIGRATION_LEDGER_TABLE} (version, name, checksum)
        VALUES (${migration.version}, ${sqlString(migration.name)}, ${sqlString(migration.checksum)})
    `);
}

export async function runDatabaseMigrations(options: {
    database: PrismaClientType;
    databasePath: string;
    userDataPath: string;
    migrations: DatabaseMigration[];
    expectedVersion?: number;
    initialDatabase: boolean;
}): Promise<DatabaseMigrationResult> {
    const expectedVersion = validateSchemaVersion(options.expectedVersion ?? DATABASE_SCHEMA_VERSION);
    const rows = await options.database.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA user_version');
    let currentVersion = normalizePragmaInteger(rows[0]?.user_version);
    const fromVersion = currentVersion;

    if (currentVersion > expectedVersion) {
        throw new Error(`Database schema v${currentVersion} is newer than this app supports (v${expectedVersion}).`);
    }

    const migrationsByVersion = new Map<number, DatabaseMigration>();
    for (const migration of options.migrations) {
        if (!Number.isSafeInteger(migration.version) || migration.version < 2) {
            throw new Error(`Invalid post-baseline migration version: ${migration.version}`);
        }
        if (migrationsByVersion.has(migration.version)) {
            throw new Error(`Duplicate database migration version: ${migration.version}`);
        }
        if (!migration.name.trim() || !migration.checksum.trim()) {
            throw new Error(`Migration ${migration.version} must have a name and checksum.`);
        }
        migrationsByVersion.set(migration.version, migration);
    }

    if (currentVersion === 0 && options.initialDatabase) {
        // The bundled Prisma schema has already created the baseline tables.
        await options.database.$transaction(async (transaction) => {
            await ensureMigrationLedger(transaction);
            await recordMigration(transaction, { version: 1, name: 'bundled-schema', checksum: BASELINE_CHECKSUM });
            await transaction.$executeRawUnsafe('PRAGMA user_version = 1');
        });
        currentVersion = 1;
    }
    if (currentVersion >= 2) {
        const ledgerRows = await options.database.$queryRawUnsafe<Array<{ version: number; name: string; checksum: string }>>(
            `SELECT version, name, checksum FROM ${MIGRATION_LEDGER_TABLE} WHERE version >= 2 ORDER BY version`,
        );
        const ledgerByVersion = new Map(ledgerRows.map((row) => [Number(row.version), row]));
        for (let version = 2; version <= currentVersion; version += 1) {
            const expected = migrationsByVersion.get(version);
            const actual = ledgerByVersion.get(version);
            if (!expected || !actual || actual.name !== expected.name || actual.checksum !== expected.checksum) {
                throw new Error(`Database migration ledger mismatch at schema version ${version}.`);
            }
        }
    }

    const pendingVersions: number[] = [];
    for (let version = currentVersion + 1; version <= expectedVersion; version += 1) {
        if (!migrationsByVersion.has(version)) {
            throw new Error(`Missing database migration for schema version ${version}.`);
        }
        pendingVersions.push(version);
    }
    if (pendingVersions.length === 0) {
        return { fromVersion, toVersion: currentVersion, applied: [], snapshotPath: null };
    }

    const snapshotPath = await createMigrationSnapshot(
        options.database,
        options.databasePath,
        options.userDataPath,
        currentVersion,
        expectedVersion,
    );
    const applied: string[] = [];
    for (const version of pendingVersions) {
        const migration = migrationsByVersion.get(version)!;
        await options.database.$transaction(async (transaction) => {
            await ensureMigrationLedger(transaction);
            await migration.up(transaction);
            await recordMigration(transaction, migration);
            await transaction.$executeRawUnsafe(`PRAGMA user_version = ${version}`);
        });
        applied.push(`${version}:${migration.name}`);
    }

    return { fromVersion, toVersion: expectedVersion, applied, snapshotPath };
}

export async function finalizeDatabaseSchema(
    database: PrismaClientType,
    expectedVersion = DATABASE_SCHEMA_VERSION,
): Promise<void> {
    const validatedVersion = validateSchemaVersion(expectedVersion);
    const rows = await database.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA quick_check');
    const checkResult = rows[0] ? Object.values(rows[0])[0] : undefined;
    if (checkResult !== 'ok') {
        throw new Error(`SQLite quick_check failed: ${String(checkResult ?? 'no result')}`);
    }
    const versionRows = await database.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA user_version');
    const actualVersion = normalizePragmaInteger(versionRows[0]?.user_version);
    if (actualVersion !== validatedVersion) {
        throw new Error(`Database schema version is v${actualVersion}; expected v${validatedVersion}.`);
    }
}
