import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-backup-archive-'));
await fs.mkdir(new URL('../node_modules/.cache/', import.meta.url), { recursive: true });
const compileRoot = await fs.mkdtemp(new URL('../node_modules/.cache/backup-archive-', import.meta.url));
const originalStatfs = fs.statfs;
try {
    await build({ entryPoints: [new URL('../electron/backup/BackupArchive.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(compileRoot, 'archive.cjs') });
    const { zipFiles, extractZip, openArchive } = require(path.join(compileRoot, 'archive.cjs'));
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'archive boundary verification');
    const safe = path.join(root, 'safe.zip');
    await zipFiles(safe, [{ name: 'safe/entry.txt', file: source }]);

    // Patch both ZIP filenames without changing their length. This exercises the
    // untrusted reader rather than only testing the path helper directly.
    const traversalBytes = await fs.readFile(safe);
    const originalName = Buffer.from('safe/entry.txt'), maliciousName = Buffer.from('../outside.txt');
    assert.equal(originalName.length, maliciousName.length);
    let changed = 0;
    for (let offset = traversalBytes.indexOf(originalName); offset !== -1; offset = traversalBytes.indexOf(originalName, offset + originalName.length)) {
        maliciousName.copy(traversalBytes, offset); changed++;
    }
    assert.equal(changed, 2);
    const traversal = path.join(root, 'traversal.zip');
    await fs.writeFile(traversal, traversalBytes);
    await assert.rejects(extractZip(traversal, path.join(root, 'untrusted')));
    assert.equal(await fs.stat(path.join(root, 'outside.txt')).catch(() => null), null);

    const duplicate = path.join(root, 'duplicate.zip');
    await zipFiles(duplicate, [{ name: 'Files/entry.txt', file: source }, { name: 'files/ENTRY.txt', file: source }]);
    await assert.rejects(extractZip(duplicate, path.join(root, 'duplicates')), error => error.code === 'CORRUPT_ARCHIVE');

    const oversizedBytes = await fs.readFile(safe);
    const local = oversizedBytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = oversizedBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(local >= 0 && central >= 0);
    oversizedBytes.writeUInt32LE(0x80000001, local + 22);
    oversizedBytes.writeUInt32LE(0x80000001, central + 24);
    const oversized = path.join(root, 'oversized.zip');
    await fs.writeFile(oversized, oversizedBytes);
    await assert.rejects(extractZip(oversized, path.join(root, 'oversized')), error => error.code === 'CORRUPT_ARCHIVE');

    // Fault injection represents a full volume without filling the user's disk.
    fs.statfs = async directory => String(directory).startsWith(root + path.sep)
        ? { bavail: 0, bsize: 4096 } : originalStatfs(directory);
    try {
        const fullVolume = path.join(root, 'full-volume');
        await assert.rejects(extractZip(safe, fullVolume), error => error.code === 'INSUFFICIENT_SPACE');
        assert.equal(await fs.stat(path.join(fullVolume, 'safe', 'entry.txt')).catch(() => null), null);
    } finally { fs.statfs = originalStatfs; }

    const futureManifest = path.join(root, 'manifest.json');
    await fs.writeFile(futureManifest, JSON.stringify({ formatVersion: 999 }));
    const future = path.join(root, 'future.nebak');
    await zipFiles(future, [{ name: 'manifest.json', file: futureManifest }, { name: 'payload.zip', file: safe }]);
    await assert.rejects(openArchive(future, path.join(root, 'future-read')), error => error.code === 'UNSUPPORTED_VERSION');

    await assert.rejects(zipFiles(path.join(root, 'missing.zip'), [{ name: 'missing.txt', file: path.join(root, 'does-not-exist') }]), error => error.code === 'ENOENT');
    const large = path.join(root, 'large.bin');
    await fs.writeFile(large, Buffer.alloc(16 * 1024 ** 2));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 0);
    try {
        await assert.rejects(zipFiles(path.join(root, 'cancelled.zip'), [{ name: 'large.bin', file: large }], true, abort.signal), error => error.name === 'AbortError');
    } finally { clearTimeout(timer); }
    // Renaming/deleting after cancellation also checks Windows reader release.
    await fs.rename(large, path.join(root, 'reader-released.bin'));
    assert.equal(await fs.readFile(source, 'utf8'), 'archive boundary verification');
    console.log('Backup archive boundaries passed: traversal, duplicate paths, size cap, insufficient space, future version, missing input and streaming cancellation.');
} finally {
    fs.statfs = originalStatfs;
    const resolved = path.resolve(root);
    const cache = path.resolve(new URL('../node_modules/.cache/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('novel-backup-archive-'));
    assert.ok(path.resolve(compileRoot).startsWith(cache + path.sep));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await fs.rm(compileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
