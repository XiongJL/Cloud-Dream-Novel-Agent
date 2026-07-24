import { createHash } from 'node:crypto';
import type {
    CreativeAssetWritebackEntityKind,
    CreativeAssetWritebackEntitySnapshot,
    DraftWritebackRecord,
} from '../../shared/draftWriteback';

type DatabaseClient = Record<string, any>;

const ENTITY_SELECTS: Record<CreativeAssetWritebackEntityKind, Record<string, boolean>> = {
    plotLine: {
        id: true,
        novelId: true,
        name: true,
        description: true,
        color: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
    },
    plotPoint: {
        id: true,
        novelId: true,
        plotLineId: true,
        title: true,
        description: true,
        type: true,
        status: true,
        icon: true,
        order: true,
        createdAt: true,
        updatedAt: true,
    },
    character: {
        id: true,
        novelId: true,
        name: true,
        role: true,
        avatar: true,
        fullBodyImages: true,
        description: true,
        profile: true,
        sortOrder: true,
        isStarred: true,
        createdAt: true,
        updatedAt: true,
    },
    item: {
        id: true,
        novelId: true,
        name: true,
        type: true,
        icon: true,
        description: true,
        profile: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
    },
    mapCanvas: {
        id: true,
        novelId: true,
        name: true,
        type: true,
        description: true,
        background: true,
        width: true,
        height: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
    },
};

function canonicalize(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalize(entry)]),
    );
}

export function hashCreativeAssetEntity(
    kind: CreativeAssetWritebackEntityKind,
    entity: Record<string, unknown>,
): string {
    const selected = Object.fromEntries(
        Object.keys(ENTITY_SELECTS[kind]).map((key) => [key, entity[key] ?? null]),
    );
    return createHash('sha256').update(JSON.stringify(canonicalize(selected)), 'utf8').digest('hex');
}

export function createCreativeAssetEntitySnapshot(
    kind: CreativeAssetWritebackEntityKind,
    entity: Record<string, unknown>,
): CreativeAssetWritebackEntitySnapshot {
    return {
        kind,
        entityId: String(entity.id || ''),
        afterHash: hashCreativeAssetEntity(kind, entity),
        ...(kind === 'mapCanvas' && typeof entity.background === 'string' && entity.background
            ? { backgroundPath: entity.background }
            : {}),
    };
}

function createConflict(message: string, details?: unknown): Error & { code: string; details?: unknown } {
    return Object.assign(new Error(message), { code: 'VERSION_CONFLICT', details });
}

function idsFor(
    entities: CreativeAssetWritebackEntitySnapshot[],
    kind: CreativeAssetWritebackEntityKind,
): string[] {
    return entities.filter((entity) => entity.kind === kind).map((entity) => entity.entityId);
}

async function loadAndVerifyEntities(
    tx: DatabaseClient,
    novelId: string,
    entities: CreativeAssetWritebackEntitySnapshot[],
    kind: CreativeAssetWritebackEntityKind,
): Promise<Record<string, unknown>[]> {
    const expected = entities.filter((entity) => entity.kind === kind);
    if (!expected.length) return [];
    const rows = await tx[kind].findMany({
        where: { id: { in: expected.map((entity) => entity.entityId) }, novelId },
        select: ENTITY_SELECTS[kind],
    });
    const byId = new Map<string, Record<string, unknown>>(
        rows.map((row: Record<string, unknown>) => [String(row.id), row]),
    );
    for (const snapshot of expected) {
        const row = byId.get(snapshot.entityId);
        if (!row || hashCreativeAssetEntity(kind, row) !== snapshot.afterHash) {
            throw createConflict('素材已在入库后发生变化，无法安全撤销', {
                kind,
                entityId: snapshot.entityId,
            });
        }
    }
    return rows;
}

async function assertNoLaterRelations(
    tx: DatabaseClient,
    entities: CreativeAssetWritebackEntitySnapshot[],
): Promise<void> {
    const plotLineIds = idsFor(entities, 'plotLine');
    const plotPointIds = idsFor(entities, 'plotPoint');
    const characterIds = idsFor(entities, 'character');
    const itemIds = idsFor(entities, 'item');
    const mapIds = idsFor(entities, 'mapCanvas');
    const allowedPlotPointIds = new Set(plotPointIds);

    const [linePoints, anchorCount, characterOwnershipCount, itemOwnershipCount, relationshipCount, markerCount, mapElementCount] = await Promise.all([
        plotLineIds.length
            ? tx.plotPoint.findMany({ where: { plotLineId: { in: plotLineIds } }, select: { id: true } })
            : [],
        plotPointIds.length
            ? tx.plotPointAnchor.count({ where: { plotPointId: { in: plotPointIds } } })
            : 0,
        characterIds.length
            ? tx.itemOwnership.count({ where: { characterId: { in: characterIds } } })
            : 0,
        itemIds.length
            ? tx.itemOwnership.count({ where: { itemId: { in: itemIds } } })
            : 0,
        characterIds.length
            ? tx.relationship.count({
                where: {
                    OR: [
                        { sourceId: { in: characterIds } },
                        { targetId: { in: characterIds } },
                    ],
                },
            })
            : 0,
        characterIds.length || mapIds.length
            ? tx.characterMapMarker.count({
                where: {
                    OR: [
                        ...(characterIds.length ? [{ characterId: { in: characterIds } }] : []),
                        ...(mapIds.length ? [{ mapId: { in: mapIds } }] : []),
                    ],
                },
            })
            : 0,
        mapIds.length
            ? tx.mapElement.count({ where: { mapId: { in: mapIds } } })
            : 0,
    ]);

    const hasUnexpectedLinePoint = linePoints.some((point: { id: string }) => !allowedPlotPointIds.has(point.id));
    if (
        hasUnexpectedLinePoint
        || anchorCount > 0
        || characterOwnershipCount > 0
        || itemOwnershipCount > 0
        || relationshipCount > 0
        || markerCount > 0
        || mapElementCount > 0
    ) {
        throw createConflict('素材已在入库后建立新的关联，无法安全撤销');
    }
}

export async function undoCreativeAssetsWriteback(
    tx: DatabaseClient,
    novelId: string,
    writeback: DraftWritebackRecord,
): Promise<{ backgroundPaths: string[] }> {
    if (writeback.mode !== 'creative_assets' || writeback.status !== 'committed' || !writeback.creativeAssets) {
        throw Object.assign(new Error('Creative assets writeback is not undoable'), { code: 'INVALID_STATE' });
    }
    const entities = writeback.creativeAssets.entities;
    if (!entities.length) {
        throw Object.assign(new Error('Creative assets writeback has no entity snapshots'), { code: 'INVALID_STATE' });
    }
    const uniqueKeys = new Set(entities.map((entity) => `${entity.kind}:${entity.entityId}`));
    if (uniqueKeys.size !== entities.length || entities.some((entity) => !entity.entityId || !entity.afterHash)) {
        throw Object.assign(new Error('Creative assets writeback snapshots are invalid'), { code: 'INVALID_STATE' });
    }

    await Promise.all((Object.keys(ENTITY_SELECTS) as CreativeAssetWritebackEntityKind[]).map((kind) => (
        loadAndVerifyEntities(tx, novelId, entities, kind)
    )));
    await assertNoLaterRelations(tx, entities);

    const plotPointIds = idsFor(entities, 'plotPoint');
    const plotLineIds = idsFor(entities, 'plotLine');
    const characterIds = idsFor(entities, 'character');
    const itemIds = idsFor(entities, 'item');
    const mapIds = idsFor(entities, 'mapCanvas');
    if (plotPointIds.length) await tx.plotPoint.deleteMany({ where: { id: { in: plotPointIds }, novelId } });
    if (plotLineIds.length) await tx.plotLine.deleteMany({ where: { id: { in: plotLineIds }, novelId } });
    if (characterIds.length) await tx.character.deleteMany({ where: { id: { in: characterIds }, novelId } });
    if (itemIds.length) await tx.item.deleteMany({ where: { id: { in: itemIds }, novelId } });
    if (mapIds.length) await tx.mapCanvas.deleteMany({ where: { id: { in: mapIds }, novelId } });

    return {
        backgroundPaths: entities.flatMap((entity) => entity.backgroundPath ? [entity.backgroundPath] : []),
    };
}
