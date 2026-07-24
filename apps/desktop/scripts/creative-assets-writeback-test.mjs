import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@novel-editor/core';
import ts from 'typescript';

const source = await readFile(new URL('../electron/automation/CreativeAssetsWriteback.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createCreativeAssetEntitySnapshot, undoCreativeAssetsWriteback } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-creative-assets-writeback-'));
const dbPath = path.join(tempRoot, 'creative-assets-writeback.db').replaceAll('\\', '/');
const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

const createWriteback = (entities) => ({
    writebackId: `writeback-${Date.now()}`,
    mode: 'creative_assets',
    status: 'committed',
    chapters: [],
    creativeAssets: {
        entities,
        created: {},
    },
    committedAt: new Date().toISOString(),
});

try {
    await client.$executeRawUnsafe(`
        CREATE TABLE PlotLine (
            id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
            color TEXT NOT NULL, sortOrder REAL NOT NULL DEFAULT 0,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE PlotPoint (
            id TEXT PRIMARY KEY, novelId TEXT NOT NULL, plotLineId TEXT NOT NULL, title TEXT NOT NULL,
            description TEXT, type TEXT NOT NULL, status TEXT NOT NULL, icon TEXT,
            "order" REAL NOT NULL DEFAULT 0,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE PlotPointAnchor (
            id TEXT PRIMARY KEY, plotPointId TEXT NOT NULL, chapterId TEXT NOT NULL, type TEXT NOT NULL,
            lexicalKey TEXT, offset INTEGER, length INTEGER,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE Character (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, avatar TEXT, fullBodyImages TEXT,
            description TEXT, profile TEXT NOT NULL DEFAULT '{}', sortOrder REAL NOT NULL DEFAULT 0,
            isStarred BOOLEAN NOT NULL DEFAULT 0, novelId TEXT NOT NULL,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE Item (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'item', icon TEXT,
            description TEXT, profile TEXT NOT NULL DEFAULT '{}', novelId TEXT NOT NULL,
            sortOrder REAL NOT NULL DEFAULT 0,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE ItemOwnership (
            id TEXT PRIMARY KEY, characterId TEXT NOT NULL, itemId TEXT NOT NULL, note TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE Relationship (
            id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, targetId TEXT NOT NULL,
            relation TEXT NOT NULL, description TEXT,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE MapCanvas (
            id TEXT PRIMARY KEY, novelId TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'world',
            description TEXT, background TEXT, width INTEGER NOT NULL DEFAULT 1200,
            height INTEGER NOT NULL DEFAULT 800, sortOrder REAL NOT NULL DEFAULT 0,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE MapElement (
            id TEXT PRIMARY KEY, mapId TEXT NOT NULL, type TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
            text TEXT, iconKey TEXT, style TEXT NOT NULL DEFAULT '{}', z INTEGER NOT NULL DEFAULT 0
        )
    `);
    await client.$executeRawUnsafe(`
        CREATE TABLE CharacterMapMarker (
            id TEXT PRIMARY KEY, characterId TEXT NOT NULL, mapId TEXT NOT NULL,
            x REAL NOT NULL, y REAL NOT NULL, label TEXT
        )
    `);

    const plotLine = await client.plotLine.create({
        data: { id: 'line-1', novelId: 'novel-1', name: '主线', color: '#123456', sortOrder: 1 },
    });
    const plotPoint = await client.plotPoint.create({
        data: {
            id: 'point-1', novelId: 'novel-1', plotLineId: plotLine.id, title: '事件',
            type: 'event', status: 'active', order: 1,
        },
    });
    const character = await client.character.create({
        data: { id: 'character-1', novelId: 'novel-1', name: '角色', profile: '{}', sortOrder: 1 },
    });
    const item = await client.item.create({
        data: { id: 'item-1', novelId: 'novel-1', name: '物品', type: 'item', profile: '{}', sortOrder: 1 },
    });
    const map = await client.mapCanvas.create({
        data: {
            id: 'map-1', novelId: 'novel-1', name: '地图', type: 'world',
            background: 'maps/novel-1/map.png', sortOrder: 1,
        },
    });
    const writeback = createWriteback([
        createCreativeAssetEntitySnapshot('plotLine', plotLine),
        createCreativeAssetEntitySnapshot('plotPoint', plotPoint),
        createCreativeAssetEntitySnapshot('character', character),
        createCreativeAssetEntitySnapshot('item', item),
        createCreativeAssetEntitySnapshot('mapCanvas', map),
    ]);
    const undoResult = await client.$transaction((tx) => undoCreativeAssetsWriteback(tx, 'novel-1', writeback));
    assert.deepEqual(undoResult.backgroundPaths, ['maps/novel-1/map.png']);
    assert.equal(await client.plotLine.count(), 0);
    assert.equal(await client.plotPoint.count(), 0);
    assert.equal(await client.character.count(), 0);
    assert.equal(await client.item.count(), 0);
    assert.equal(await client.mapCanvas.count(), 0);

    const edited = await client.character.create({
        data: { id: 'character-edited', novelId: 'novel-1', name: '待编辑角色', profile: '{}', sortOrder: 2 },
    });
    const editedWriteback = createWriteback([createCreativeAssetEntitySnapshot('character', edited)]);
    await client.character.update({ where: { id: edited.id }, data: { description: '入库后补充的内容' } });
    await assert.rejects(
        () => client.$transaction((tx) => undoCreativeAssetsWriteback(tx, 'novel-1', editedWriteback)),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    assert.equal(await client.character.count({ where: { id: edited.id } }), 1);

    const linkedCharacter = await client.character.create({
        data: { id: 'character-linked', novelId: 'novel-1', name: '关联角色', profile: '{}', sortOrder: 3 },
    });
    const linkedItem = await client.item.create({
        data: { id: 'item-linked', novelId: 'novel-1', name: '关联物品', type: 'item', profile: '{}', sortOrder: 3 },
    });
    const linkedWriteback = createWriteback([
        createCreativeAssetEntitySnapshot('character', linkedCharacter),
        createCreativeAssetEntitySnapshot('item', linkedItem),
    ]);
    await client.itemOwnership.create({
        data: { id: 'ownership-1', characterId: linkedCharacter.id, itemId: linkedItem.id },
    });
    await assert.rejects(
        () => client.$transaction((tx) => undoCreativeAssetsWriteback(tx, 'novel-1', linkedWriteback)),
        (error) => error?.code === 'VERSION_CONFLICT',
    );
    assert.equal(await client.character.count({ where: { id: linkedCharacter.id } }), 1);
    assert.equal(await client.item.count({ where: { id: linkedItem.id } }), 1);

    console.log('Creative assets atomic writeback undo and conflict protection tests passed.');
} finally {
    await client.$disconnect();
    await fs.rm(tempRoot, { recursive: true, force: true });
}
