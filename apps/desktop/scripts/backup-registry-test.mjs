import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../electron/backup/BackupRegistry.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { BACKUP_TABLES, excludedTable } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const schema = await readFile(new URL('../../../packages/core/prisma/schema.prisma', import.meta.url), 'utf8');
const sql = await readFile(new URL('../../../packages/core/generated/client/schema-init.sql', import.meta.url), 'utf8');
for (const table of [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(match => match[1])) {
    assert.ok(BACKUP_TABLES.includes(table) || excludedTable(table), `New Prisma model ${table} must be classified for backup`);
}
for (const table of [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map(match => match[1])) {
    assert.ok(BACKUP_TABLES.includes(table) || excludedTable(table), `New generated table ${table} must be classified for backup`);
}
assert.equal(new Set(BACKUP_TABLES).size, BACKUP_TABLES.length);
assert.ok(BACKUP_TABLES.includes('_IdeaToTag'));
assert.equal(excludedTable('FutureUserData'), false);
console.log('Backup registry covers the Prisma schema and generated SQL, including implicit edges.');
