import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, pbkdf2, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { BackupInspection, BackupMode, BackupOperation, BackupProgress } from '../../shared/backup';
import { BACKUP_TABLES, backupError, tableCatalog, sqlName, type Column, type BackupDatabase } from './BackupRegistry';
import { fileHash, openArchive, safeChild, sealArchive, zipFiles } from './BackupArchive';
import { DatasetManager, durableJson, validateActivationResources, type DatasetLocation } from './DatasetManager';

type Database = BackupDatabase & { $disconnect(): Promise<void>; $transaction<T>(callback: (db: BackupDatabase) => Promise<T>, options?: any): Promise<T> };
type Row = Record<string, any>;
interface Entry { name: string; hash: string; size: number; count?: number; columns?: Column[] }
interface Bundle { version: 2; schemaVersion: number; snapshotAt: string; backupId: string; domains: Record<string, Entry>; resources: Array<Entry & { original: string }>; files: Entry[]; warnings: string[] }

function packDigest(stableId: string, version: string, bindings: unknown): string {
    const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
        : JSON.stringify(value);
    return createHash('sha256').update(canonical({stableId,version,bindings}), 'utf8').digest('hex');
}
interface Inspected { inspection: BackupInspection; root: string; source: string; sourceHash: string; bundle: Bundle; currentFingerprint: string; expires: number }
export interface BackupEngineOptions {
    dataset: DatasetManager;
    database: Database;
    createDatabase(file: string): Database;
    appVersion: string;
    schemaVersion: number;
    progress?(progress: BackupProgress): void;
}
function json(value: unknown): string { return JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { $bigint: String(v) } : v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v); }
async function* rows(file: string, signal?: AbortSignal): AsyncGenerator<Row> {
    // readline receives bounded chunks. Limit a line before buffering it in readline.
    const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024, signal });
    let lineBytes = 0;
    stream.on('data', chunk => {
        for (const byte of chunk as Buffer) { lineBytes = byte === 10 ? 0 : lineBytes + 1; if (lineBytes > 64 * 1024 ** 2) { stream.destroy(backupError('CORRUPT_ARCHIVE', '单条数据记录超过上限。')); break; } }
    });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let failure: Error | undefined;
    stream.on('error', error => { failure = error; reader.close(); });
    try { for await (const line of reader) { signal?.throwIfAborted(); if (line.trim()) { const row = JSON.parse(line); if (!row || Array.isArray(row) || typeof row !== 'object') throw backupError('CORRUPT_ARCHIVE', '数据记录格式无效。'); yield row; } } if (failure) throw failure; } finally { reader.close(); stream.destroy(); }
}
async function writeRows(file: string, iterable: AsyncIterable<Row>): Promise<number> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let count = 0;
    await pipeline(Readable.from((async function* () { for await (const row of iterable) { count++; yield json(row) + '\n'; } })()), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    return count;
}
async function* databaseRows(database: BackupDatabase, table: string, signal?: AbortSignal): AsyncGenerator<Row> {
    const columns = await database.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info(${sqlName(table)})`);
    const bytes = columns.map(column => `coalesce(length(cast(${sqlName(column.name)} as blob)), 0)`).join(' + ');
    let cursor = -9223372036854775808n;
    for (;;) {
        signal?.throwIfAborted();
        const positions = await database.$queryRawUnsafe<Array<{ position: bigint; bytes: bigint }>>(`SELECT _rowid_ AS position, (${bytes}) AS bytes FROM ${sqlName(table)} WHERE _rowid_ > ? ORDER BY _rowid_ LIMIT 200`, cursor);
        if (!positions.length) return;
        let group: bigint[] = [], size = 0;
        async function* readGroup(): AsyncGenerator<Row> {
            if (!group.length) return;
            signal?.throwIfAborted();
            const records = await database.$queryRawUnsafe<Row[]>(`SELECT * FROM ${sqlName(table)} WHERE _rowid_ IN (${group.map(() => '?').join(',')}) ORDER BY _rowid_`, ...group);
            for (const record of records) yield record;
        }
        for (const position of positions) {
            const recordBytes = Number(position.bytes);
            if (recordBytes > 64 * 1024 ** 2) throw backupError('REFERENCE_INVALID', '单条业务记录超过 64 MiB 安全读取上限。');
            if (group.length && size + recordBytes > 8 * 1024 ** 2) { yield* readGroup(); group = []; size = 0; }
            group.push(position.position); size += recordBytes;
        }
        yield* readGroup();
        cursor = positions[positions.length - 1].position;
    }
}
function walk(value: any, transform: (value: string, key: string) => string, key = ''): any {
    if (typeof value === 'string') {
        if ((key.endsWith('Json') || ['content', 'profile', 'formatting', 'fullBodyImages', 'instructions', 'style', 'keyFacts', 'entitiesSnapshot', 'timelineHints', 'openQuestions', 'unresolvedThreads', 'styleGuide', 'hardConstraints', 'coverageChapterIds'].includes(key)) && /^[\[{]/.test(value.trim())) {
            let parsed: any;
            try { parsed = JSON.parse(value); } catch { return transform(value, key); }
            // Only editor documents carry structured references in content.
            // JSON examples in author prose remain verbatim text on copy restore.
            if (key === 'content' && (parsed?.root?.type !== 'root' || !Array.isArray(parsed.root.children))) return transform(value, key);
            const next = walk(parsed, transform, key.replace(/Json$/, ''));
            // Original JSON bytes underpin chapter versions and draft hashes.
            return json(next) === json(parsed) ? value : json(next);
        }
        return transform(value, key);
    }
    if (Array.isArray(value)) return value.map(item => walk(item, transform, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, transform, k)]));
    return value;
}
function transformRow(row: Row, transform: (value: string, key: string) => string): Row {
    return walk(row, transform);
}
async function entry(root: string, name: string, count?: number, columns?: Column[]): Promise<Entry> {
    const file = safeChild(root, name);
    return { name, hash: await fileHash(file), size: (await fsp.stat(file)).size, ...(count === undefined ? {} : { count }), ...(columns ? { columns } : {}) };
}
function resourcePath(value: string): string { return value.replace(/^local-resource:\/\//, ''); }
function resourceCandidate(value: string): boolean { return /^(covers|characters|maps|resources)\//.test(resourcePath(value)); }
const IMAGE_FIELDS = new Set(['coverUrl', 'avatar', 'fullBodyImages', 'background', 'src', 'path', 'imagePath', 'backgroundPath', 'imageUrl']);
const TERMINAL_RUNS = new Set(['completed', 'failed', 'cancelled', 'idle']);
async function ensureSpace(directory: string, bytes: number): Promise<void> {
    await fsp.mkdir(directory, { recursive: true });
    const volume = await fsp.statfs(directory);
    if (Number(volume.bavail) * Number(volume.bsize) < bytes + Math.max(512 * 1024 ** 2, bytes * 0.1)) throw backupError('INSUFFICIENT_SPACE', '可用磁盘空间不足，请清理空间后重试；原资料与现有备份保留。');
}

export class BackupEngine {
    private inspections = new Map<string, Inspected>();
    private controller?: AbortController;
    private committing = false;
    private operation?: BackupOperation;
    begin(operation?: BackupOperation): void { this.controller = new AbortController(); this.committing = false; this.operation = operation; }
    end(): void { this.controller = undefined; this.operation = undefined; }
    cancel(): boolean { if (this.committing) return false; this.controller?.abort(backupError('CANCELLED', '操作已取消，原资料保留。')); return true; }
    private get signal(): AbortSignal | undefined { return this.controller?.signal; }
    constructor(readonly options: BackupEngineOptions) {}
    private progress(phase: BackupProgress['phase'], message: string, completed = 0, total?: number): void { this.signal?.throwIfAborted(); this.options.progress?.({ phase, message, completed, total, operation: this.operation }); }
    private async temporary(): Promise<string> {
        const root = path.join(this.options.dataset.userRoot, 'recovery', 'temporary');
        await fsp.mkdir(root, { recursive: true, mode: 0o700 });
        const temporary = await fsp.mkdtemp(path.join(root, 'backup-'));
        await durableJson(path.join(temporary, 'job-owner.json'), { pid: process.pid, createdAt: new Date().toISOString() });
        return temporary;
    }
    async cleanupAbandoned(): Promise<void> {
        const root = path.join(this.options.dataset.userRoot, 'recovery', 'temporary');
        if (!fs.existsSync(root)) return;
        for (const directory of await fsp.readdir(root, { withFileTypes: true })) {
            if (!directory.isDirectory() || directory.isSymbolicLink() || !/^backup-[A-Za-z0-9]+$/.test(directory.name)) continue;
            const candidate = safeChild(root, directory.name);
            const marker = path.join(candidate, 'job-owner.json');
            let owner: any;
            try { if ((await fsp.stat(marker)).size > 4096) continue; owner = JSON.parse(await fsp.readFile(marker, 'utf8')); } catch { continue; }
            if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
            try { process.kill(owner.pid, 0); } catch (error: any) {
                if (error.code === 'ESRCH') await fsp.rm(candidate, { recursive: true, force: true });
            }
        }
    }
    async fingerprint(): Promise<string> {
        const catalog = await tableCatalog(this.options.database);
        const hash = createHash('sha256');
        const resources = new Set<string>();
        for (const table of BACKUP_TABLES) {
            if (!catalog[table]) continue;
            hash.update(table);
            for await (const row of databaseRows(this.options.database, table, this.signal)) {
                hash.update(json(row));
                transformRow(row, (value, key) => { if (IMAGE_FIELDS.has(key) && resourceCandidate(value)) resources.add(resourcePath(value)); return value; });
            }
        }
        const comments = path.join(this.options.dataset.current().root, 'automation', 'review-comments.json');
        if (fs.existsSync(comments)) hash.update(await fileHash(comments));
        for (const relative of [...resources].sort()) { hash.update(relative); const file = safeChild(this.options.dataset.current().root, relative); hash.update(fs.existsSync(file) ? await fileHash(file) : 'MISSING'); }
        return hash.digest('hex');
    }
    async assertIdle(): Promise<void> {
        const runs = await this.options.database.$queryRawUnsafe<Row[]>('SELECT status FROM AgentRun');
        const operations = await this.options.database.$queryRawUnsafe<Row[]>('SELECT status FROM DraftGenerationOperation');
        if (runs.some(run => !TERMINAL_RUNS.has(run.status)) || operations.some(op => !['succeeded', 'definitive_failed', 'cancelled', 'reconcile_required'].includes(op.status))) throw backupError('BUSY', '有 Agent 任务尚未结束，请先等待完成或在 Agent 中停止任务。');
    }
    async snapshot(): Promise<{ root: string; file: string }> {
        await tableCatalog(this.options.database);
        await ensureSpace(this.options.dataset.userRoot, (await fsp.stat(this.options.dataset.current().databasePath)).size * 6);
        const root = await this.temporary();
        const file = path.join(root, 'snapshot.db');
        try { await this.options.database.$executeRawUnsafe('VACUUM INTO ?', file); return { root, file }; } catch (error) { await fsp.rm(root, { recursive: true, force: true }); throw error; }
    }
    async export(target: string, password?: string): Promise<void> {
        const signal = this.signal;
        this.progress('snapshotting', '固定数据库、资料与图片快照');
        const snapshot = await this.snapshot();
        let database: Database | undefined;
        const partial = `${target}.${randomUUID()}.partial`;
        try {
            await this.validateDataset({ id: null, root: snapshot.root, databasePath: snapshot.file });
            database = this.options.createDatabase(snapshot.file);
            const catalog = await tableCatalog(database);
            if ((await database.$queryRawUnsafe<Row[]>('PRAGMA foreign_key_check')).length) throw backupError('REFERENCE_INVALID', '当前资料有缺失关联，请先修复后创建完整备份。');
            const root = path.join(snapshot.root, 'bundle');
            await fsp.mkdir(root, { recursive: true });
            const bundle: Bundle = { version: 2, schemaVersion: this.options.schemaVersion, snapshotAt: new Date().toISOString(), backupId: randomUUID(), domains: {}, resources: [], files: [], warnings: ['附件包含已保存的提取文本与结构，不包含未持久保存的原附件文件。', 'RAG 与全文索引不打包，恢复后重建；Agent 历史不会自动续跑。', '恢复的自定义 Skill 默认停用，审阅后可手动启用。'] };
            const resources = new Set<string>();
            const externalImages = new Set<string>();
            for (const [table, columns] of Object.entries(catalog)) {
                const name = `data/${table}.ndjson`;
                const count = await writeRows(safeChild(root, name), (async function* () {
                    for await (const row of databaseRows(database!, table, signal)) {
                        transformRow(row, (value, key) => {
                            if (IMAGE_FIELDS.has(key) && resourceCandidate(value)) resources.add(resourcePath(value));
                            if (IMAGE_FIELDS.has(key)) {
                                if (/^https?:\/\//i.test(value)) externalImages.add(value);
                                else if (path.isAbsolute(value)) throw backupError('RESOURCE_EXTERNAL', '图片引用了外部绝对路径，请先使用图片导入功能保存到作品资料目录。');
                            }
                            return value;
                        });
                        yield row;
                    }
                })());
                bundle.domains[table] = await entry(root, name, count, columns);
                this.progress('snapshotting', '正在保存作品、设定与历史资料', Object.keys(bundle.domains).length, BACKUP_TABLES.length);
            }
            if (externalImages.size) bundle.warnings.push(`包含 ${externalImages.size} 项外部图片链接，已保留链接；没有自动下载，离线可能无法显示。`);
            for (const relative of resources) {
                const source = safeChild(this.options.dataset.current().root, relative);
                const stat = await fsp.lstat(source).catch(() => null);
                if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw backupError('RESOURCE_MISSING', `受管图片 ${relative} 缺失，未生成不完整备份。`);
                const actual = await fsp.realpath(source), actualRoot = await fsp.realpath(this.options.dataset.current().root);
                if (!actual.startsWith(actualRoot + path.sep)) throw backupError('RESOURCE_MISSING', '受管图片路径指向数据集之外，请重新导入图片。');
                if (stat.size > 2 * 1024 ** 3) throw backupError('RESOURCE_MISSING', '单个资源超过 2 GiB。');
                await ensureSpace(snapshot.root, stat.size * 4);
                const hash = await fileHash(source, signal);
                const name = `resources/${hash}`;
                const destination = safeChild(root, name);
                await fsp.mkdir(path.dirname(destination), { recursive: true });
                if (!fs.existsSync(destination)) await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
                if (await fileHash(destination, signal) !== hash) throw backupError('SNAPSHOT_FAILED', '图片在快照期间发生变化。');
                bundle.resources.push({ ...(await entry(root, name)), original: relative });
            }
            const comments = path.join(this.options.dataset.current().root, 'automation', 'review-comments.json');
            if (fs.existsSync(comments)) {
                await fsp.mkdir(path.join(root, 'files'), { recursive: true });
                const parsed = JSON.parse(await fsp.readFile(comments, 'utf8'));
                if (!Array.isArray(parsed.comments)) throw backupError('REFERENCE_INVALID', '审批意见文件格式错误。');
                await fsp.copyFile(comments, path.join(root, 'files', 'review-comments.json'));
                bundle.files.push(await entry(root, 'files/review-comments.json', parsed.comments.length));
            }
            const datasetRoot = this.options.dataset.current().root;
            const history = path.join(datasetRoot, 'agent', 'agent_state.db');
            const archived: string[] = [];
            const historyRoot = path.join(datasetRoot, 'restored-history');
            if (fs.existsSync(historyRoot)) for (const directory of await fsp.readdir(historyRoot, { withFileTypes: true })) {
                if (!directory.isDirectory() || directory.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(directory.name)) throw backupError('UNREGISTERED_DOMAIN', '历史调用存储存在未登记内容。');
                const file = path.join(historyRoot, directory.name, 'runtime-history.ndjson');
                if (fs.existsSync(file)) archived.push(file);
            }
            let runtime: Database | undefined;
            let hasInvocations = false;
            try {
            if (fs.existsSync(history)) {
                runtime = this.options.createDatabase(history);
                const names = await runtime.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table'");
                if (names.some(item => !['agent_state', 'run_events', 'tool_invocations'].includes(item.name) && !item.name.startsWith('sqlite_'))) throw backupError('UNREGISTERED_DOMAIN', 'Runtime 存储有新增数据领域，请登记历史备份规则。');
                hasInvocations = names.some(item => item.name === 'tool_invocations');
            }
                if (hasInvocations || archived.length) {
                    const name = 'files/runtime-history.ndjson';
                    const count = await writeRows(safeChild(root, name), (async function* () {
                        const seen = new Set<string>();
                        const sources = [...(hasInvocations ? [databaseRows(runtime!, 'tool_invocations', signal)] : []), ...archived.map(file => rows(file, signal))];
                        for (const source of sources) for await (const row of source) {
                            const identity = createHash('sha256').update(json(row)).digest('hex');
                            if (!seen.has(identity)) { seen.add(identity); yield row; }
                        }
                    })());
                    bundle.files.push(await entry(root, name, count));
                }
            } finally { await runtime?.$disconnect(); }
            await durableJson(path.join(root, 'bundle-manifest.json'), bundle);
            const entries = [...Object.values(bundle.domains), ...bundle.resources, ...bundle.files].filter((value, i, all) => all.findIndex(v => v.name === value.name) === i);
            const payload = path.join(snapshot.root, 'payload.zip');
            this.progress('packaging', '压缩与保护完整载荷');
            await zipFiles(payload, [{ name: 'bundle-manifest.json', file: path.join(root, 'bundle-manifest.json') }, ...entries.map(value => ({ name: value.name, file: safeChild(root, value.name) }))], true, signal);
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await ensureSpace(path.dirname(target), (await fsp.stat(payload)).size + 16 * 1024 ** 2);
            await sealArchive(payload, partial, { formatVersion: 2, backupId: bundle.backupId, appVersion: this.options.appVersion, createdAt: bundle.snapshotAt, sourcePlatform: process.platform, encrypted: Boolean(password), payloadBytes: 0, payloadSha256: '' }, password, signal);
            this.progress('verifying', '重新读取并校验备份');
            const verification = path.join(snapshot.root, 'verify');
            const opened = await openArchive(partial, verification, password, signal);
            await this.validateBundle(opened.payload);
            // Do not destroy a valid file before the replacement has been verified.
            await fsp.rename(partial, target);
            this.progress('completed', '完整备份已创建');
        } finally {
            await database?.$disconnect();
            await fsp.rm(partial, { force: true });
            await fsp.rm(snapshot.root, { recursive: true, force: true });
        }
    }
    private async validateBundle(root: string): Promise<Bundle> {
        const bundle = JSON.parse(await fsp.readFile(path.join(root, 'bundle-manifest.json'), 'utf8')) as Bundle;
        if (bundle.version !== 2 || !Number.isInteger(bundle.schemaVersion) || bundle.schemaVersion > this.options.schemaVersion) throw backupError('UNSUPPORTED_VERSION', '备份数据版本较新，请升级应用。');
        if (!bundle.domains || !Array.isArray(bundle.resources) || !Array.isArray(bundle.files)) throw backupError('CORRUPT_ARCHIVE', '备份清单格式错误。');
        const current = await tableCatalog(this.options.database);
        for (const table of BACKUP_TABLES) {
            const domain = bundle.domains[table];
            if (table === 'AgentSkillPackPreference' && !domain) continue;
            if (!current[table]) throw backupError('UNSUPPORTED_VERSION', `请先升级数据表 ${table}`);
            if (!domain || domain.name !== `data/${table}.ndjson` || !Array.isArray(domain.columns)) throw backupError('CORRUPT_ARCHIVE', `缺少必需领域 ${table}`);
            if (domain.columns.some(c => !current[table].some(known => known.name === c.name && known.type === c.type))) throw backupError('UNSUPPORTED_VERSION', `数据表 ${table} 字段不兼容。`);
            let count = 0;
            for await (const row of rows(safeChild(root, domain.name), this.signal)) {
                if (Object.keys(row).some(key => !domain.columns!.some(c => c.name === key))) throw backupError('CORRUPT_ARCHIVE', `数据表 ${table} 包含未声明字段。`);
                count++;
            }
            if (count !== domain.count) throw backupError('CORRUPT_ARCHIVE', '记录数量与清单不一致。');
        }
        if (Object.keys(bundle.domains).some(table => !(BACKUP_TABLES as readonly string[]).includes(table))) throw backupError('UNSUPPORTED_VERSION', '备份包含尚未支持的数据领域。');
        for (const item of [...Object.values(bundle.domains), ...bundle.resources, ...bundle.files]) {
            if (typeof item.name !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) throw backupError('CORRUPT_ARCHIVE', '文件清单无效。');
            const file = safeChild(root, item.name);
            if ((await fsp.stat(file)).size !== item.size || await fileHash(file, this.signal) !== item.hash) throw backupError('CORRUPT_ARCHIVE', '备份内容校验失败。');
        }
        const allowedFiles = new Set(['files/review-comments.json', 'files/runtime-history.ndjson']);
        if (bundle.files.some(item => !allowedFiles.has(item.name))) throw backupError('UNSUPPORTED_VERSION', '未知文件存储领域。');
        const resourceNames = new Set<string>();
        for (const resource of bundle.resources) { safeChild(root, resource.original); if (resourceNames.has(resource.original) || !resourceCandidate(resource.original) || resource.name !== `resources/${resource.hash}`) throw backupError('CORRUPT_ARCHIVE', '资源映射无效或重复。'); resourceNames.add(resource.original); }
        const expected = new Set(['bundle-manifest.json', ...Object.values(bundle.domains).map(file => file.name), ...bundle.resources.map(file => file.name), ...bundle.files.map(file => file.name)]);
        async function verifyNames(directory: string, prefix = ''): Promise<void> {
            for (const file of await fsp.readdir(directory, { withFileTypes: true })) {
                const name = prefix + file.name;
                if (file.isDirectory()) await verifyNames(path.join(directory, file.name), name + '/');
                else if (!expected.has(name)) throw backupError('CORRUPT_ARCHIVE', '载荷包含未登记文件。');
            }
        }
        await verifyNames(root);
        return bundle;
    }
    async inspect(source: string, password?: string): Promise<BackupInspection> {
        await this.cleanExpired();
        this.progress('inspecting', '校验格式、数据与图片');
        const root = await this.temporary();
        try {
            const sourceHash = await fileHash(source, this.signal);
            const opened = await openArchive(source, root, password, this.signal);
            const legacy = opened.header.version === 1;
            const payload = legacy ? await this.convertLegacy(opened.outer, root, opened.header, password) : opened.payload;
            const bundle = await this.validateBundle(payload);
            const volumes = new Map<string, string>();
            for await (const row of rows(safeChild(payload, bundle.domains.Volume.name), this.signal)) volumes.set(row.id, row.novelId);
            const counts = new Map<string, number>();
            for await (const row of rows(safeChild(payload, bundle.domains.Chapter.name), this.signal)) { const novel = volumes.get(row.volumeId); if (novel) counts.set(novel, (counts.get(novel) || 0) + 1); }
            const novels: BackupInspection['novels'] = [];
            for await (const row of rows(safeChild(payload, bundle.domains.Novel.name), this.signal)) novels.push({ id: row.id, title: row.title, chapters: counts.get(row.id) || 0 });
            const inspection: BackupInspection = { inspectionId: randomUUID(), formatVersion: legacy ? 1 : 2, createdAt: opened.header.createdAt, completeness: legacy ? 'legacy_incomplete' : 'complete', novels, records: Object.values(bundle.domains).reduce((sum, domain) => sum + (domain.count || 0), 0), resources: bundle.resources.length, warnings: bundle.warnings, allowedModes: legacy ? ['copy'] : ['copy', 'replace_all'] };
            if (sourceHash !== await fileHash(source, this.signal)) throw backupError('PLAN_STALE', '备份文件在预检时发生变化，请重新选择。');
            this.inspections.set(inspection.inspectionId, { inspection, root: payload, source, sourceHash, bundle, currentFingerprint: await this.fingerprint(), expires: Date.now() + 10 * 60000 });
            return inspection;
        } catch (error) { await fsp.rm(root, { recursive: true, force: true }); throw error; }
    }
    private async convertLegacy(outer: string, root: string, header: any, password?: string): Promise<string> {
        let dataFile = path.join(outer, 'data.json');
        if (header.encrypted) {
            if (!password) throw backupError('PASSWORD_REQUIRED', '请输入备份密码。');
            const e = header.encryption;
            if (!e || e.algo !== 'aes-256-gcm' || !/^[a-f0-9]{32}$/i.test(e.salt) || !/^[a-f0-9]{24}$/i.test(e.iv) || !/^[a-f0-9]{32}$/i.test(e.authTag)) throw backupError('CORRUPT_ARCHIVE', '旧备份加密参数无效。');
            const key = await promisify(pbkdf2)(password, Buffer.from(e.salt, 'hex'), 100000, 32, 'sha256');
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex')); decipher.setAuthTag(Buffer.from(e.authTag, 'hex'));
            dataFile = path.join(root, 'legacy.json');
            try { await pipeline(fs.createReadStream(path.join(outer, 'data.bin')), decipher, fs.createWriteStream(dataFile, { mode: 0o600 })); } catch { throw backupError('DECRYPTION_FAILED', '密码错误或旧备份损坏。'); } finally { key.fill(0); }
        }
        if ((await fsp.stat(dataFile)).size > 256 * 1024 ** 2) throw backupError('CORRUPT_ARCHIVE', '旧格式载荷超过安全读取上限。');
        const data = JSON.parse(await fsp.readFile(dataFile, 'utf8'));
        const known: Record<string, string> = { Novel: 'novels', Volume: 'volumes', Chapter: 'chapters', Character: 'characters', Idea: 'ideas', Tag: 'tags', AgentConversation: 'agentConversations', AgentMessage: 'agentMessages', AgentAttachment: 'agentAttachments' };
        const payload = path.join(root, 'converted');
        const bundle: Bundle = { version: 2, schemaVersion: this.options.schemaVersion, snapshotAt: header.createdAt, backupId: randomUUID(), domains: {}, resources: [], files: [], warnings: ['旧版备份未包含物品、世界观、故事结构、地图、标签关联、图片、报告、草稿及审批意见。仅允许恢复为副本。'] };
        const catalog = await tableCatalog(this.options.database);
        for (const table of BACKUP_TABLES) {
            if (!catalog[table]) continue;
            const records = known[table] ? data[known[table]] ?? [] : [];
            if (!Array.isArray(records)) throw backupError('CORRUPT_ARCHIVE', '旧备份数据格式错误。');
            const name = `data/${table}.ndjson`;
            const count = await writeRows(safeChild(payload, name), (async function* () {
                for (const record of records) { const cleaned = Object.fromEntries(Object.entries(record).filter(([key]) => catalog[table].some(column => column.name === key))); yield cleaned; }
            })());
            bundle.domains[table] = await entry(payload, name, count, catalog[table]);
        }
        await durableJson(path.join(payload, 'bundle-manifest.json'), bundle);
        return payload;
    }
    async cleanExpired(): Promise<void> {
        for (const [key, item] of this.inspections) if (item.expires < Date.now()) { this.inspections.delete(key); await fsp.rm(path.dirname(item.root), { recursive: true, force: true }); }
    }
    async dispose(): Promise<void> {
        for (const [key, item] of this.inspections) { this.inspections.delete(key); await fsp.rm(path.dirname(item.root), { recursive: true, force: true }); }
    }
    async restore(inspectionId: string, mode: BackupMode): Promise<{ rollbackPath: string; location: DatasetLocation }> {
        const item = this.inspections.get(inspectionId);
        if (!item || item.expires < Date.now()) throw backupError('PLAN_STALE', '预览已过期，请重新选择备份。');
        if (!item.inspection.allowedModes.includes(mode)) throw backupError('INCOMPLETE_LEGACY', '旧版不完整备份只能恢复为副本。');
        if (await fileHash(item.source, this.signal) !== item.sourceHash || await this.fingerprint() !== item.currentFingerprint) throw backupError('PLAN_STALE', '备份文件或当前资料已变化，请重新预览。');
        await this.validateBundle(item.root);
        const rollbackPath = path.join(this.options.dataset.userRoot, 'backups', 'rollback', `before-${Date.now()}-${randomUUID()}.nebak`);
        await this.export(rollbackPath);
        const snapshot = await this.snapshot();
        const candidate = await this.options.dataset.candidate();
        let database: Database | undefined;
        try {
            this.progress('staging', '在独立数据集中构建恢复内容');
            await fsp.copyFile(snapshot.file, candidate.databasePath);
            if (mode === 'copy') {
                const source = this.options.dataset.current().root;
                for (const folder of ['covers', 'characters', 'maps', 'resources', 'automation', 'agent', 'restored-history']) {
                    const dir = path.join(source, folder);
                    if (fs.existsSync(dir)) await fsp.cp(dir, path.join(candidate.root, folder), { recursive: true, filter: value => !value.endsWith('runtime.json') && !value.endsWith('.tmp') && !fs.lstatSync(value).isSymbolicLink() });
                }
            }
            database = this.options.createDatabase(candidate.databasePath);
            const current = await tableCatalog(database);
            const idMap = new Map<string, string>();
            if (mode === 'copy') {
                for (const [table, domain] of Object.entries(item.bundle.domains)) {
                    const keys = domain.columns!.filter(c => c.pk && c.name !== 'revision' && c.name !== 'childIndex');
                    for await (const row of rows(safeChild(item.root, domain.name), this.signal)) for (const key of keys) if (typeof row[key.name] === 'string' && !idMap.has(row[key.name])) idMap.set(row[key.name], randomUUID());
                    if (table === 'DraftGenerationOperation') for await (const row of rows(safeChild(item.root, domain.name), this.signal)) idMap.set(row.operationKey, randomUUID());
                }
            }
            const resources = new Map(item.bundle.resources.map(resource => [resource.original, mode === 'replace_all' ? resource.original : `${resource.original.split('/')[0]}/restored-${resource.hash}${path.posix.extname(resource.original)}`]));
            const validPackRevisions = new Set<string>();
            if (mode === 'copy' && item.bundle.domains.AgentSkillPack && item.bundle.domains.AgentSkillPackRevision) {
                const definitions = new Map<string, Row>();
                for await (const row of rows(safeChild(item.root, item.bundle.domains.AgentSkillPack.name), this.signal)) definitions.set(row.id, row);
                for await (const row of rows(safeChild(item.root, item.bundle.domains.AgentSkillPackRevision.name), this.signal)) {
                    try { if (row.contentHash === packDigest(definitions.get(row.packId)?.stableId, row.version, JSON.parse(row.bindingsJson))) validPackRevisions.add(idMap.get(row.id)!); }
                    catch { /* Keep an already invalid revision invalid, rather than blessing it. */ }
                }
            }
            const transform = (value: string, key: string) => {
                if (IMAGE_FIELDS.has(key) && resources.has(resourcePath(value))) return (value.startsWith('local-resource://') ? 'local-resource://' : '') + resources.get(resourcePath(value))!;
                if (item.inspection.completeness === 'legacy_incomplete' && IMAGE_FIELDS.has(key) && resourceCandidate(value)) return `${resourcePath(value).split('/')[0]}/missing-${item.bundle.backupId}-${path.posix.basename(value)}`;
                if (mode !== 'copy') return value;
                if (/^(id|ids|A|B)$|(?:Id|Ids|Key)$/.test(key)) {
                    if (idMap.has(value)) return idMap.get(value)!;
                    if (key === 'targetId' || key === 'reviewVersionId') for (const [old, next] of idMap) if (value.startsWith(`${old}:`)) return next + value.slice(old.length);
                }
                return value;
            };
            await database.$transaction(async tx => {
                await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
                if (mode === 'replace_all') for (const table of BACKUP_TABLES) if (current[table]) await tx.$executeRawUnsafe(`DELETE FROM ${sqlName(table)}`);
                for (const [table, domain] of Object.entries(item.bundle.domains)) {
                    for await (const original of rows(safeChild(item.root, domain.name), this.signal)) {
                        const row = transformRow(original, transform);
                        if (mode === 'copy' && table === 'Novel') row.title = `${row.title}（恢复副本）`;
                        if (mode === 'copy' && ['AgentSkill', 'AgentSkillPack'].includes(table)) row.stableId = `${row.stableId}-restored-${item.bundle.backupId.slice(0, 8)}`;
                        this.isolate(table, row, item.bundle.backupId, mode);
                        const fields = Object.keys(row).filter(key => current[table].some(c => c.name === key));
                        if (!fields.length) throw backupError('REFERENCE_INVALID', '记录没有有效字段。');
                        const values = fields.map(key => {
                            const value = row[key]; const column = current[table].find(c => c.name === key)!;
                            if (value && typeof value === 'object' && '$bigint' in value) return BigInt(value.$bigint);
                            if (value && typeof value === 'object' && '$bytes' in value && column.type.toUpperCase() === 'BLOB') return Buffer.from(value.$bytes, 'base64');
                            if (column.type.toUpperCase().includes('DATE') && typeof value === 'string') { const date = new Date(value); if (Number.isNaN(date.getTime())) throw backupError('REFERENCE_INVALID', '日期字段无效。'); return date; }
                            if (value && typeof value === 'object') throw backupError('REFERENCE_INVALID', '数据库字段值格式无效。');
                            return value;
                        });
                        await tx.$executeRawUnsafe(`INSERT INTO ${sqlName(table)} (${fields.map(sqlName).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...values);
                    }
                }
                await tx.$executeRawUnsafe('DELETE FROM SyncState');
                if (validPackRevisions.size) {
                    const imported = await tx.$queryRawUnsafe<Row[]>('SELECT r."id",r."version",r."bindingsJson",p."stableId" FROM "AgentSkillPackRevision" r JOIN "AgentSkillPack" p ON p."id"=r."packId"');
                    for (const row of imported) if (validPackRevisions.has(row.id)) await tx.$executeRawUnsafe('UPDATE "AgentSkillPackRevision" SET "contentHash"=? WHERE "id"=?', packDigest(row.stableId,row.version,JSON.parse(row.bindingsJson)),row.id);
                }
                const broken = await tx.$queryRawUnsafe<any[]>('PRAGMA foreign_key_check');
                if (broken.length) throw backupError('REFERENCE_INVALID', '数据关系校验失败，原数据未改变。');
            }, { maxWait: 10000, timeout: 600000 });
            for (const resource of item.bundle.resources) {
                const destination = safeChild(candidate.root, resources.get(resource.original)!);
                await fsp.mkdir(path.dirname(destination), { recursive: true });
                if (!fs.existsSync(destination)) await fsp.copyFile(safeChild(item.root, resource.name), destination);
            }
            for (const file of item.bundle.files) {
                if (file.name === 'files/review-comments.json') {
                    const source = JSON.parse(await fsp.readFile(safeChild(item.root, file.name), 'utf8'));
                    if (!Array.isArray(source.comments)) throw backupError('REFERENCE_INVALID', '审批意见格式无效。');
                    const target = path.join(candidate.root, 'automation', 'review-comments.json');
                    const previous = mode === 'copy' && fs.existsSync(target) ? JSON.parse(await fsp.readFile(target, 'utf8')).comments : [];
                    const imported = walk(source.comments, transform).map((comment: Row) => ({ ...comment, commentId: mode === 'copy' ? randomUUID() : comment.commentId }));
                    await durableJson(target, { comments: [...previous, ...imported] });
                } else {
                    const target = path.join(candidate.root, 'restored-history', item.bundle.backupId, 'runtime-history.ndjson');
                    await fsp.mkdir(path.dirname(target), { recursive: true });
                    await fsp.copyFile(safeChild(item.root, file.name), target);
                }
            }
            // The cutover marker belongs to the target generation, never the source device.
            await durableJson(path.join(candidate.root, 'automation', 'durable-draft-cutover-v2.json'), { version: 2, completedAt: new Date().toISOString(), restored: true });
            await durableJson(path.join(candidate.root, 'restore-report.json'), { backupId: item.bundle.backupId, mode, createdAt: new Date().toISOString(), records: item.inspection.records, resources: item.inspection.resources, warnings: item.inspection.warnings, runtimePolicy: 'archive_only' });
            // Drop rebuilt caches in the isolated candidate. Do not pay for embeddings.
            await database.$executeRawUnsafe('DROP TABLE IF EXISTS search_index');
            const cache = await database.$queryRawUnsafe<Row[]>("SELECT name FROM sqlite_master WHERE type='table' AND name='rag_vector_chunks'");
            if (cache.length) await database.$executeRawUnsafe('DELETE FROM rag_vector_chunks');
            await database.$disconnect(); database = undefined;
            await this.validateDataset(candidate);
            const resourceManifest: Entry[] = [];
            for (const resource of item.bundle.resources) {
                const relative = resources.get(resource.original)!;
                const file = safeChild(candidate.root, relative);
                if (await fileHash(file, this.signal) !== resource.hash) throw backupError('REFERENCE_INVALID', '候选图片与备份校验值不一致。');
                const handle = await fsp.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
                resourceManifest.push({ name: relative, hash: resource.hash, size: resource.size });
            }
            await durableJson(path.join(candidate.root, 'activation-resources.json'), resourceManifest);
            this.progress('committing', '切换已校验数据集，应用将重新启动');
            this.committing = true;
            await this.options.dataset.activate(candidate, rollbackPath);
            this.inspections.delete(inspectionId);
            await fsp.rm(path.dirname(item.root), { recursive: true, force: true }).catch(() => undefined);
            return { rollbackPath, location: candidate };
        } catch (error) {
            await database?.$disconnect(); database = undefined;
            // Once a pointer might have switched, leave the candidate and journal for
            // deterministic startup recovery, rather than deleting the active dataset.
            if (this.options.dataset.current().id !== candidate.id) await fsp.rm(candidate.root, { recursive: true, force: true });
            throw error;
        } finally { await database?.$disconnect(); await fsp.rm(snapshot.root, { recursive: true, force: true }); }
    }
    private isolate(table: string, row: Row, backupId: string, mode: BackupMode): void {
        if (table === 'AgentRun' && !TERMINAL_RUNS.has(row.status)) {
            row.recoveryJson = json({ imported: true, originalStatus: row.status, backupId }); row.status = 'failed'; row.pendingApprovalJson = null; row.pendingUserInputJson = null;
        }
        if (table === 'AgentConversation') {
            row.runtimeConversationId = null; row.pendingUserInputJson = null;
            if (row.runJson) { try { const run = JSON.parse(row.runJson); if (run && !TERMINAL_RUNS.has(run.status)) { run.status = 'failed'; run.pendingApproval = null; run.pendingUserInput = null; run.error = '备份恢复后任务已中断，请基于历史重新开始。'; row.runJson = json(run); } } catch { row.runJson = null; } }
        }
        if (table === 'DraftGenerationOperation') {
            row.leaseOwner = null; row.leaseExpiresAt = null;
            if (!['succeeded', 'definitive_failed', 'cancelled', 'reconcile_required'].includes(row.status)) { row.status = 'reconcile_required'; row.phase = 'terminal'; row.errorCode = 'RESTORED_OPERATION'; }
        }
        if (table === 'DraftOperationOutbox') row.deliveryStatus = 'restored_archive';
        if (['AgentSkill', 'AgentSkillBinding', 'AgentSkillPack', 'AgentSkillPackPreference'].includes(table)) row.enabled = false;
        if (mode === 'copy' && ['ChapterSummary', 'NarrativeSummary'].includes(table)) { row.status = 'stale'; row.isLatest = false; }
        if (mode === 'copy' && ['DraftSession', 'DraftBatch'].includes(table)) {
            // Historical hashes refer to the original identity. Readable drafts are
            // preserved, but must be regenerated/revalidated before a new writeback.
            const payload = JSON.parse(row.payloadJson);
            payload.restoreOrigin = { backupId, requiresRevalidation: true };
            row.payloadJson = json(payload);
        }
    }
    async validateDataset(location: DatasetLocation, activationCheck = false): Promise<void> {
        if (!fs.existsSync(location.databasePath)) throw backupError('ACTIVATION_FAILED', '数据集数据库不存在。');
        const database = this.options.createDatabase(location.databasePath);
        try {
            const check = await database.$queryRawUnsafe<Array<Record<string, string>>>('PRAGMA integrity_check');
            if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw backupError('REFERENCE_INVALID', '数据库完整性检查失败。');
            await tableCatalog(database);
            const foreign = await database.$queryRawUnsafe<any[]>('PRAGMA foreign_key_check');
            if (foreign.length) throw backupError('REFERENCE_INVALID', '数据库关系检查失败。');
            // These stores intentionally use scalar IDs rather than SQLite FKs.
            // Validate their live ownership explicitly before opening a writer.
            for (const table of ['MapCanvas', 'DraftSession', 'DraftBatch', 'DraftGenerationOperation', 'AgentRevisionTask']) {
                const broken = await database.$queryRawUnsafe<Row[]>(`SELECT a.novelId FROM ${sqlName(table)} a LEFT JOIN Novel n ON a.novelId = n.id WHERE n.id IS NULL LIMIT 1`);
                if (broken.length) throw backupError('REFERENCE_INVALID', '作品归属校验失败，原资料未被替换。');
            }
            for (const table of ['DraftSession', 'DraftBatch']) for await (const row of databaseRows(database, table, this.signal)) {
                const payload = JSON.parse(row.payloadJson);
                const idKey = table === 'DraftSession' ? 'draftSessionId' : 'draftBatchId';
                if (!payload || payload[idKey] !== row[idKey] || payload.novelId !== row.novelId || payload.version !== Number(row.version)) throw backupError('REFERENCE_INVALID', '草稿身份或版本快照不一致。');
            }
            for await (const chapter of databaseRows(database, 'Chapter', this.signal)) {
                // New chapters use '', and the editor supports legacy plain text
                // and falls back to text for unparseable JSON. Back up the exact
                // stored string; normalization would alter version/draft hashes.
                if (typeof chapter.content !== 'string') throw backupError('REFERENCE_INVALID', `章节正文存储类型无效（章节 ${chapter.id}）。`);
            }
            const comments = path.join(location.root, 'automation', 'review-comments.json');
            if (fs.existsSync(comments)) {
                const value = JSON.parse(await fsp.readFile(comments, 'utf8'));
                if (!Array.isArray(value.comments) || value.comments.some((comment: Row) => typeof comment.commentId !== 'string' || typeof comment.novelId !== 'string')) throw backupError('REFERENCE_INVALID', '审批意见文件结构无效。');
            }
            if (activationCheck) await validateActivationResources(location);
        } finally { await database.$disconnect(); }
    }
}
