import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, createCipheriv, createDecipheriv, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import { backupError } from './BackupRegistry';

const derive = promisify(pbkdf2);
const MAX_TOTAL = 50 * 1024 ** 3;
const MAX_ENTRY = 2 * 1024 ** 3;
export async function fileHash(file: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest('hex');
}
export function safeChild(root: string, relative: string): string {
    if (!relative || relative.includes('\\') || /[:<>"|?*\x00-\x1f]/.test(relative) || relative.startsWith('/') || relative.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw backupError('CORRUPT_ARCHIVE', '备份包含非法资源路径。');
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw backupError('CORRUPT_ARCHIVE', '备份路径超出暂存目录。');
    return resolved;
}
export async function zipFiles(target: string, entries: Array<{ name: string; file: string }>, compress = true, signal?: AbortSignal): Promise<void> {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    const done = pipeline(zip.outputStream, output, { signal });
    const readers = new Set<fs.ReadStream>();
    zip.on('error', error => (zip.outputStream as Readable).destroy(error));
    try {
        for (const entry of entries) zip.addReadStreamLazy(entry.name, { compress, mode: 0o100600 }, callback => {
            const reader = fs.createReadStream(entry.file, { signal });
            readers.add(reader);
            reader.on('close', () => readers.delete(reader));
            reader.on('error', error => zip.emit('error', error));
            callback(null, reader);
        });
        zip.end();
        await done;
    } catch (error) {
        (zip.outputStream as Readable).destroy(error as Error);
        await done.catch(() => undefined);
        throw error;
    } finally {
        await Promise.all([...readers].map(async reader => { const closed = new Promise<void>(resolve => reader.once('close', resolve)); reader.destroy(); await closed; }));
    }
}
export async function extractZip(source: string, root: string, outer = false, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if ((await fsp.stat(source)).size > 20 * 1024 ** 3) throw backupError('CORRUPT_ARCHIVE', '备份文件超过 20 GiB 上限。');
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(source, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, result) => err || !result ? reject(err) : resolve(result)));
    const seen = new Set<string>();
    let total = 0;
    await new Promise<void>((resolve, reject) => {
        const fail = (error: unknown) => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', resolve);
        zip.on('entry', (entry: yauzl.Entry) => {
            void (async () => {
                const name = entry.fileName;
                const key = name.normalize('NFC').toLocaleLowerCase('en-US');
                if (seen.has(key) || seen.size >= 100000 || name.endsWith('/') || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw backupError('CORRUPT_ARCHIVE', '备份包含重复、目录或符号链接条目。');
                seen.add(key);
                if (outer && !['manifest.json', 'payload.zip', 'payload.bin', 'data.json', 'data.bin'].includes(name)) throw backupError('CORRUPT_ARCHIVE', '备份包含未知载荷。');
                const cap = name.endsWith('manifest.json') ? 16 * 1024 ** 2 : outer ? 20 * 1024 ** 3 : MAX_ENTRY;
                if (entry.uncompressedSize > cap || total + entry.uncompressedSize > MAX_TOTAL) throw backupError('CORRUPT_ARCHIVE', '备份解压大小超过限制。');
                const volume = await fsp.statfs(root);
                if (Number(volume.bavail) * Number(volume.bsize) < entry.uncompressedSize + Math.max(512 * 1024 ** 2, entry.uncompressedSize * 0.1)) throw backupError('INSUFFICIENT_SPACE', '可用空间不足，无法安全预检备份。');
                const target = safeChild(root, name);
                await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                const input = await new Promise<fs.ReadStream>((res, rej) => zip.openReadStream(entry, (err, stream) => err || !stream ? rej(err) : res(stream as fs.ReadStream)));
                let count = 0;
                const limit = new Transform({ transform(chunk, _encoding, callback) {
                    count += chunk.length; total += chunk.length;
                    callback(count > cap || total > MAX_TOTAL ? backupError('CORRUPT_ARCHIVE', '解压载荷超过限制。') : null, chunk);
                } });
                await pipeline(input, limit, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
                if (count !== entry.uncompressedSize) throw backupError('CORRUPT_ARCHIVE', '备份条目长度错误。');
                zip.readEntry();
            })().catch(fail);
        });
        zip.readEntry();
    });
}
export interface ArchiveHeader {
    formatVersion: 2; backupId: string; appVersion: string; createdAt: string;
    sourcePlatform: string; encrypted: boolean; payloadBytes: number; payloadSha256: string;
    encryption?: { kdf: 'pbkdf2-sha256'; iterations: number; salt: string; iv: string; authTag: string };
}
function aad(header: ArchiveHeader): Buffer {
    return Buffer.from(JSON.stringify([header.formatVersion, header.backupId, header.appVersion, header.createdAt, header.sourcePlatform, header.encrypted, header.encryption?.kdf, header.encryption?.iterations, header.encryption?.salt, header.encryption?.iv]));
}
export async function sealArchive(payload: string, target: string, header: ArchiveHeader, password?: string, signal?: AbortSignal): Promise<void> {
    const root = path.dirname(payload);
    let load = payload;
    if (password) {
        const salt = randomBytes(16), iv = randomBytes(12);
        header.encryption = { kdf: 'pbkdf2-sha256', iterations: 600000, salt: salt.toString('hex'), iv: iv.toString('hex'), authTag: '' };
        const key = await derive(password, salt, 600000, 32, 'sha256');
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(header));
        load = path.join(root, 'encrypted.bin');
        try { await pipeline(fs.createReadStream(payload), cipher, fs.createWriteStream(load, { flags: 'wx', mode: 0o600 }), { signal }); header.encryption.authTag = cipher.getAuthTag().toString('hex'); } finally { key.fill(0); }
    }
    header.payloadBytes = (await fsp.stat(load)).size;
    header.payloadSha256 = await fileHash(load, signal);
    const manifest = path.join(root, 'outer-manifest.json');
    await fsp.writeFile(manifest, JSON.stringify(header), { mode: 0o600 });
    await zipFiles(target, [{ name: 'manifest.json', file: manifest }, { name: password ? 'payload.bin' : 'payload.zip', file: load }], false, signal);
}
export async function openArchive(file: string, root: string, password?: string, signal?: AbortSignal): Promise<{ outer: string; payload: string; header: ArchiveHeader | any }> {
    const outer = path.join(root, 'outer');
    await extractZip(file, outer, true, signal);
    const header = JSON.parse(await fsp.readFile(path.join(outer, 'manifest.json'), 'utf8'));
    if (header.version === 1 && header.formatVersion === undefined) return { outer, payload: '', header };
    if (header.formatVersion !== 2) throw backupError('UNSUPPORTED_VERSION', '不支持此备份版本，请升级应用。');
    if (typeof header.encrypted !== 'boolean' || typeof header.payloadSha256 !== 'string') throw backupError('CORRUPT_ARCHIVE', '备份头无效。');
    let payload = path.join(outer, header.encrypted ? 'payload.bin' : 'payload.zip');
    const outerFiles = await fsp.readdir(outer);
    if (outerFiles.length !== 2 || !outerFiles.includes(header.encrypted ? 'payload.bin' : 'payload.zip')) throw backupError('CORRUPT_ARCHIVE', '备份包含额外载荷。');
    if ((await fsp.stat(payload)).size !== header.payloadBytes || await fileHash(payload, signal) !== header.payloadSha256) throw backupError('CORRUPT_ARCHIVE', '备份载荷校验失败。');
    if (header.encrypted) {
        if (!password) throw backupError('PASSWORD_REQUIRED', '请输入备份密码。');
        const e = header.encryption;
        if (!e || e.kdf !== 'pbkdf2-sha256' || !Number.isInteger(e.iterations) || e.iterations < 100000 || e.iterations > 2000000 || !/^[a-f0-9]{32}$/.test(e.salt) || !/^[a-f0-9]{24}$/.test(e.iv) || !/^[a-f0-9]{32}$/.test(e.authTag)) throw backupError('CORRUPT_ARCHIVE', '不支持的加密参数。');
        const key = await derive(password, Buffer.from(e.salt, 'hex'), e.iterations, 32, 'sha256');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex'));
        decipher.setAAD(aad(header)); decipher.setAuthTag(Buffer.from(e.authTag, 'hex'));
        const decoded = path.join(root, 'decoded.zip');
        try { await pipeline(fs.createReadStream(payload), decipher, fs.createWriteStream(decoded, { flags: 'wx', mode: 0o600 }), { signal }); } catch { signal?.throwIfAborted(); throw backupError('DECRYPTION_FAILED', '密码错误或备份认证失败。'); } finally { key.fill(0); }
        payload = decoded;
    }
    const extracted = path.join(root, 'payload');
    await extractZip(payload, extracted, false, signal);
    return { outer, payload: extracted, header };
}
