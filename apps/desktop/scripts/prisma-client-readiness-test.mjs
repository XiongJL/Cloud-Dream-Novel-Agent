import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Load the actual preflight functions without running the Prisma CLI.
const source = fs.readFileSync(new URL('../../../packages/core/scripts/generate-prisma-client.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function schemaTokens(');
const end = source.indexOf('\nif (canReuseGeneratedClient())', start);
assert.ok(start > 0 && end > start);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-client-readiness-'));
const generatedClientDir = path.join(root, 'generated');
const sdkDir = path.join(root, 'sdk');
const prismaEnginesDir = path.join(root, 'engines');
const schemaPath = path.join(root, 'schema.prisma');
const queryEngineLibraryFile = 'query_engine-test.node';
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const version = JSON.stringify({ version: '6.19.2' });
const runtime = '"use strict"; module.exports = { version: 6 };';
const schema = 'model Example {\n  id String @id\n  title String @default("a b")\n}';
const formatted = 'model Example {\n  id    String @id\n  title String @default("a b")\n}\n';
try {
    write(schemaPath, schema);
    write(path.join(generatedClientDir, 'schema.prisma'), formatted);
    write(path.join(generatedClientDir, 'package.json'), version);
    write(path.join(sdkDir, 'package.json'), version);
    for (const name of ['index.d.ts', 'default.js', 'default.d.ts', 'edge.js', 'index-browser.js', 'runtime/library.d.ts']) write(path.join(generatedClientDir, name), 'fixture');
    write(path.join(generatedClientDir, 'index.js'), 'const metadata = { client: "6.19.2" };');
    write(path.join(generatedClientDir, 'runtime/library.js'), '/* Generated runtime */\n// lint disabled\n' + runtime);
    write(path.join(sdkDir, 'runtime/library.js'), runtime);
    write(path.join(prismaEnginesDir, queryEngineLibraryFile), 'native-engine-v6');
    write(path.join(generatedClientDir, queryEngineLibraryFile), 'native-engine-v6');
    const check = new Function('fs', 'path', 'createHash', 'options', `
        const { schemaPath, generatedClientDir, prismaEnginesDir, queryEngineLibraryFile, resolvePackageJson } = options;
        ${source.slice(start, end)}
        return canReuseGeneratedClient;
    `)(fs, path, createHash, {
        schemaPath, generatedClientDir, prismaEnginesDir, queryEngineLibraryFile,
        resolvePackageJson: () => path.join(sdkDir, 'package.json'),
    });
    assert.equal(check(), true, 'formatting and generated runtime comments allow safe reuse');
    for (const changed of [schema.replace('a b', 'ab'), schema.replace('id String', 'id Int'), schema.replace('model Example', 'modelExample'), schema.replace('\n}', '\n added Int\n}')]) {
        write(schemaPath, changed);
        assert.equal(check(), false, 'changed defaults, identifiers and models require regeneration');
    }
    write(schemaPath, schema);
    for (const [name, changed] of [
        ['package.json', JSON.stringify({ version: '5.10.2' })],
        ['index.js', 'const metadata = { client: "5.10.2" };'],
        [queryEngineLibraryFile, 'native-engine-v5'],
        ['runtime/library.js', runtime.replace('version: 6', 'version: 5')],
    ]) {
        const file = path.join(generatedClientDir, name);
        const original = fs.readFileSync(file);
        write(file, changed);
        assert.equal(check(), false, `stale ${name} cannot be reused`);
        fs.writeFileSync(file, original);
    }
    fs.unlinkSync(path.join(generatedClientDir, 'default.js'));
    assert.equal(check(), false, 'an incomplete client requires regeneration');
    console.log('Prisma client readiness passed: formatting, quoted defaults, schema changes, SDK/runtime/engine versions and missing files.');
} finally {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
}
