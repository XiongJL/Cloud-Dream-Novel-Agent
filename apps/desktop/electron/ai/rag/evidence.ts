import { db } from '@novel-editor/core';
import { search } from '../../search/searchIndex';
import type { RagDetectionResult, RagEvidenceItem, RagIntent } from './types';
import { queryRagVectorIndex } from './vectorIndex';
import type { AiEmbeddingSettings } from '../types';

function trimText(value: unknown, maxLen: number): string {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function parseJsonArray(value: unknown): string[] {
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return [];
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function parseProfile(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim() === '{}') return '';
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object') return '';
        return Object.entries(parsed as Record<string, unknown>)
            .map(([key, val]) => `${key}: ${String(val || '')}`)
            .filter((line) => !line.endsWith(': '))
            .join('; ');
    } catch {
        return value;
    }
}

function hasEntityMatch(text: unknown, entityNames: string[]): boolean {
    const haystack = String(text || '').toLowerCase();
    return entityNames.some((name) => haystack.includes(name.toLowerCase()));
}

function scoreForIntent(base: number, intent: RagIntent, sourceType: RagEvidenceItem['sourceType']): number {
    if (intent === 'future_plot_for_entity' && sourceType === 'plotPoint') return base + 40;
    if (intent === 'outline_next' && (sourceType === 'plotPoint' || sourceType === 'plotLine')) return base + 35;
    if (intent === 'character_state' && (sourceType === 'character' || sourceType === 'relationship' || sourceType === 'item' || sourceType === 'map')) return base + 30;
    if (intent === 'unresolved_threads' && (sourceType === 'narrativeSummary' || sourceType === 'chapterSummary' || sourceType === 'plotPoint')) return base + 25;
    return base;
}

function addEvidence(
    items: RagEvidenceItem[],
    input: Omit<RagEvidenceItem, 'id'>,
): void {
    const id = `E${items.length + 1}`;
    const excerpt = trimText(input.excerpt, 900);
    if (!excerpt) return;
    items.push({ id, ...input, excerpt });
}

export async function getKnownRagEntityNames(novelId: string): Promise<string[]> {
    const [characters, items, worldSettings] = await Promise.all([
        (db as any).character.findMany({ where: { novelId }, select: { name: true } }),
        (db as any).item.findMany({ where: { novelId }, select: { name: true } }),
        (db as any).worldSetting.findMany({ where: { novelId }, select: { name: true } }),
    ]);
    const names = [...characters, ...items, ...worldSettings]
        .map((item: any) => String(item?.name || '').trim())
        .filter(Boolean);
    return Array.from(new Set(names));
}

export async function collectRagEvidence(input: {
    novelId: string;
    chapterId?: string;
    currentContent?: string;
    selectedText?: string;
    currentLocation?: string;
    detection: RagDetectionResult;
    question: string;
    maxEvidenceItems?: number;
    locale?: string;
    embeddingSettings?: AiEmbeddingSettings;
}): Promise<{ evidence: RagEvidenceItem[]; warnings: string[]; usedContext: string[] }> {
    const maxEvidenceItems = Math.max(4, Math.min(24, input.maxEvidenceItems ?? 12));
    const entityNames = input.detection.entityNames;
    const keywords = input.detection.keywords;
    const intent = input.detection.intent;
    const evidence: RagEvidenceItem[] = [];
    const warnings: string[] = [];
    const usedContext = new Set<string>();
    const isZh = (input.locale || 'zh').startsWith('zh');

    const [characters, items, worldSettings, plotLines, narrativeSummaries, chapterSummaries, currentChapter] = await Promise.all([
        (db as any).character.findMany({
            where: { novelId: input.novelId },
            include: {
                items: { include: { item: true } },
                relationsAsSource: { include: { target: true } },
                relationsAsTarget: { include: { source: true } },
                mapMarkers: { include: { map: true } },
            },
            orderBy: [{ isStarred: 'desc' }, { sortOrder: 'asc' }],
            take: 100,
        }),
        (db as any).item.findMany({
            where: { novelId: input.novelId },
            include: { owners: { include: { character: true } } },
            orderBy: { sortOrder: 'asc' },
            take: 120,
        }),
        (db as any).worldSetting.findMany({
            where: { novelId: input.novelId },
            orderBy: { sortOrder: 'asc' },
            take: 80,
        }),
        (db as any).plotLine.findMany({
            where: { novelId: input.novelId },
            include: {
                points: {
                    include: {
                        anchors: { include: { chapter: { select: { title: true, order: true, volume: { select: { title: true, order: true } } } } } },
                    },
                    orderBy: { order: 'asc' },
                },
            },
            orderBy: { sortOrder: 'asc' },
        }),
        (db as any).narrativeSummary.findMany({
            where: { novelId: input.novelId, isLatest: true, status: 'active' },
            orderBy: { updatedAt: 'desc' },
            take: 3,
        }),
        (db as any).chapterSummary.findMany({
            where: { novelId: input.novelId, isLatest: true, status: 'active' },
            orderBy: { updatedAt: 'desc' },
            take: 12,
        }),
        input.chapterId
            ? db.chapter.findUnique({
                where: { id: input.chapterId },
                select: { id: true, title: true, order: true, volume: { select: { title: true, order: true } } },
            })
            : null,
    ]);

    if (input.selectedText?.trim()) {
        addEvidence(evidence, {
            sourceType: 'currentContext',
            sourceId: input.chapterId || 'selectedText',
            title: 'Selected text',
            excerpt: input.selectedText,
            score: 95,
        });
        usedContext.add('selected_text');
    }
    if (input.currentContent?.trim()) {
        addEvidence(evidence, {
            sourceType: 'currentContext',
            sourceId: input.chapterId || 'currentContent',
            title: currentChapter?.title ? `Current chapter: ${currentChapter.title}` : 'Current chapter context',
            excerpt: input.currentContent.slice(-1600),
            metadata: currentChapter ? { chapterOrder: currentChapter.order, volumeTitle: currentChapter.volume?.title } : undefined,
            score: 55,
        });
        usedContext.add('current_chapter_context');
    }
    if (input.currentLocation?.trim()) {
        addEvidence(evidence, {
            sourceType: 'currentContext',
            sourceId: 'currentLocation',
            title: 'Current location',
            excerpt: input.currentLocation,
            score: 50,
        });
        usedContext.add('current_location');
    }

    const vectorEvidence = await queryRagVectorIndex({
        novelId: input.novelId,
        query: input.question,
        limit: Math.min(8, maxEvidenceItems),
        settings: input.embeddingSettings,
    });
    for (const item of vectorEvidence) {
        addEvidence(evidence, {
            ...item,
            score: 90 + Math.max(0, item.score || 0),
        });
    }
    if (vectorEvidence.length > 0) {
        usedContext.add('vector_chunks');
    }

    const relevantCharacters = characters.filter((character: any) => (
        entityNames.length === 0
            ? keywords.some((keyword) => hasEntityMatch(`${character.name} ${character.role} ${character.description} ${character.profile}`, [keyword]))
            : hasEntityMatch(character.name, entityNames)
    ));
    for (const character of relevantCharacters.slice(0, 8)) {
        const profile = parseProfile(character.profile);
        const ownedItems = Array.isArray(character.items)
            ? character.items.map((owner: any) => `${owner.item?.name || ''}${owner.note ? `(${owner.note})` : ''}`).filter(Boolean).join(', ')
            : '';
        addEvidence(evidence, {
            sourceType: 'character',
            sourceId: character.id,
            title: `Character: ${character.name}`,
            excerpt: [
                character.role ? `Role: ${character.role}` : '',
                character.description ? `Description: ${character.description}` : '',
                profile ? `Profile: ${profile}` : '',
                ownedItems ? `Owned items: ${ownedItems}` : '',
            ].filter(Boolean).join('\n'),
            metadata: { name: character.name, isStarred: character.isStarred },
            score: scoreForIntent(100 + (character.isStarred ? 10 : 0), intent, 'character'),
        });
        usedContext.add('characters');

        for (const relation of [...(character.relationsAsSource || []), ...(character.relationsAsTarget || [])].slice(0, 8)) {
            const other = relation.target?.name || relation.source?.name || '';
            addEvidence(evidence, {
                sourceType: 'relationship',
                sourceId: relation.id,
                title: `Relationship: ${character.name} - ${other}`,
                excerpt: `${relation.relation || ''}${relation.description ? `: ${relation.description}` : ''}`,
                metadata: { characterName: character.name, relatedName: other },
                score: scoreForIntent(80, intent, 'relationship'),
            });
        }

        for (const marker of (character.mapMarkers || []).slice(0, 6)) {
            addEvidence(evidence, {
                sourceType: 'map',
                sourceId: marker.id,
                title: `Map: ${marker.map?.name || marker.mapId}`,
                excerpt: `${character.name} marker${marker.label ? `: ${marker.label}` : ''}`,
                metadata: { characterName: character.name, mapId: marker.mapId, mapType: marker.map?.type },
                score: scoreForIntent(70, intent, 'map'),
            });
        }
    }

    for (const item of items) {
        const itemText = `${item.name} ${item.type} ${item.description} ${item.profile}`;
        if (entityNames.length > 0 && !hasEntityMatch(itemText, entityNames)) continue;
        if (entityNames.length === 0 && !keywords.some((keyword) => hasEntityMatch(itemText, [keyword]))) continue;
        const profile = parseProfile(item.profile);
        const owners = Array.isArray(item.owners)
            ? item.owners.map((owner: any) => `${owner.character?.name || ''}${owner.note ? `(${owner.note})` : ''}`).filter(Boolean).join(', ')
            : '';
        addEvidence(evidence, {
            sourceType: 'item',
            sourceId: item.id,
            title: `${item.type || 'Item'}: ${item.name}`,
            excerpt: [
                item.description ? `Description: ${item.description}` : '',
                profile ? `Profile: ${profile}` : '',
                owners ? `Owners: ${owners}` : '',
            ].filter(Boolean).join('\n'),
            score: scoreForIntent(78, intent, 'item'),
        });
        usedContext.add('items');
    }

    for (const world of worldSettings) {
        const worldText = `${world.name} ${world.content} ${world.type}`;
        if (entityNames.length > 0 && !hasEntityMatch(worldText, entityNames)) continue;
        if (entityNames.length === 0 && !keywords.some((keyword) => hasEntityMatch(worldText, [keyword]))) continue;
        addEvidence(evidence, {
            sourceType: 'worldSetting',
            sourceId: world.id,
            title: `World: ${world.name}`,
            excerpt: world.content,
            metadata: { type: world.type },
            score: 65,
        });
        usedContext.add('world_settings');
    }

    for (const line of plotLines) {
        const lineMatches = entityNames.length === 0
            ? keywords.some((keyword) => hasEntityMatch(`${line.name} ${line.description}`, [keyword]))
            : hasEntityMatch(`${line.name} ${line.description}`, entityNames);
        if (lineMatches || intent === 'outline_next' || intent === 'unresolved_threads') {
            addEvidence(evidence, {
                sourceType: 'plotLine',
                sourceId: line.id,
                title: `Plot line: ${line.name}`,
                excerpt: line.description || line.name,
                score: scoreForIntent(lineMatches ? 85 : 45, intent, 'plotLine'),
            });
            usedContext.add('plot_outline');
        }
        for (const point of (line.points || [])) {
            const pointText = `${line.name} ${line.description || ''} ${point.title} ${point.description || ''}`;
            const matches = entityNames.length === 0
                ? keywords.some((keyword) => hasEntityMatch(pointText, [keyword]))
                : hasEntityMatch(pointText, entityNames);
            const includeForOutline = intent === 'outline_next' && point.status !== 'resolved';
            const includeForThreads = intent === 'unresolved_threads' && point.status !== 'resolved';
            if (!matches && !includeForOutline && !includeForThreads) continue;
            const anchors = Array.isArray(point.anchors)
                ? point.anchors.map((anchor: any) => {
                    const chapter = anchor.chapter;
                    return `${anchor.type}: ${chapter?.volume?.title || ''} ${chapter?.title || anchor.chapterId}`.trim();
                }).join('; ')
                : '';
            addEvidence(evidence, {
                sourceType: 'plotPoint',
                sourceId: point.id,
                title: `Plot point: ${point.title}`,
                excerpt: [
                    `Line: ${line.name}`,
                    `Status: ${point.status || 'active'}`,
                    point.description ? `Description: ${point.description}` : '',
                    anchors ? `Anchors: ${anchors}` : '',
                ].filter(Boolean).join('\n'),
                metadata: { plotLineId: line.id, status: point.status, type: point.type },
                score: scoreForIntent((matches ? 105 : 70) + (point.status === 'resolved' ? -20 : 20), intent, 'plotPoint'),
            });
            usedContext.add('plot_points');
        }
    }

    for (const summary of narrativeSummaries) {
        const unresolvedThreads = parseJsonArray(summary.unresolvedThreads);
        const keyFacts = parseJsonArray(summary.keyFacts);
        const hardConstraints = parseJsonArray(summary.hardConstraints);
        const summaryText = [
            summary.summaryText,
            keyFacts.length ? `Key facts: ${keyFacts.join('; ')}` : '',
            unresolvedThreads.length ? `Unresolved threads: ${unresolvedThreads.join('; ')}` : '',
            hardConstraints.length ? `Hard constraints: ${hardConstraints.join('; ')}` : '',
        ].filter(Boolean).join('\n');
        const matches = entityNames.length === 0
            ? keywords.some((keyword) => hasEntityMatch(summaryText, [keyword]))
            : hasEntityMatch(summaryText, entityNames);
        if (!matches && !['outline_next', 'unresolved_threads', 'general_qa'].includes(intent)) continue;
        addEvidence(evidence, {
            sourceType: 'narrativeSummary',
            sourceId: summary.id,
            title: `${summary.level || 'novel'} summary: ${summary.title || 'latest'}`,
            excerpt: summaryText,
            score: scoreForIntent(matches ? 90 : 55, intent, 'narrativeSummary'),
        });
        usedContext.add('narrative_summaries');
    }

    for (const summary of chapterSummaries) {
        const openQuestions = parseJsonArray(summary.openQuestions);
        const timelineHints = parseJsonArray(summary.timelineHints);
        const keyFacts = parseJsonArray(summary.keyFacts);
        const summaryText = [
            summary.compressedMemory || summary.summaryText,
            keyFacts.length ? `Key facts: ${keyFacts.join('; ')}` : '',
            timelineHints.length ? `Timeline hints: ${timelineHints.join('; ')}` : '',
            openQuestions.length ? `Open questions: ${openQuestions.join('; ')}` : '',
        ].filter(Boolean).join('\n');
        const matches = entityNames.length === 0
            ? keywords.some((keyword) => hasEntityMatch(summaryText, [keyword]))
            : hasEntityMatch(summaryText, entityNames);
        if (!matches && intent !== 'unresolved_threads') continue;
        addEvidence(evidence, {
            sourceType: 'chapterSummary',
            sourceId: summary.id,
            title: `Chapter summary: ${summary.chapterId}`,
            excerpt: summaryText,
            metadata: { chapterId: summary.chapterId, chapterOrder: summary.chapterOrder },
            score: scoreForIntent(matches ? 85 : 60, intent, 'chapterSummary'),
        });
        usedContext.add('chapter_summaries');
    }

    const searchTerms = Array.from(new Set([...entityNames, ...keywords])).slice(0, 6);
    for (const term of searchTerms) {
        const hits = await search(input.novelId, term, 5, 0);
        for (const hit of hits.slice(0, 4)) {
            addEvidence(evidence, {
                sourceType: hit.entityType === 'idea' ? 'idea' : 'searchHit',
                sourceId: hit.entityId,
                title: hit.title || term,
                excerpt: hit.preview || hit.snippet,
                metadata: {
                    keyword: term,
                    chapterId: hit.chapterId,
                    volumeTitle: hit.volumeTitle,
                    matchType: hit.matchType,
                },
                score: hit.matchType === 'title' ? 62 : 42,
            });
            usedContext.add('search_hits');
        }
    }

    const deduped = new Map<string, RagEvidenceItem>();
    for (const item of evidence) {
        const key = `${item.sourceType}:${item.sourceId}:${item.title}`;
        const existing = deduped.get(key);
        if (!existing || (item.score || 0) > (existing.score || 0)) {
            deduped.set(key, item);
        }
    }

    const ranked = Array.from(deduped.values())
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, maxEvidenceItems)
        .map((item, index) => ({ ...item, id: `E${index + 1}` }));

    if (ranked.length === 0) {
        warnings.push(isZh ? '未找到相关证据，本次回答应视为低置信度。' : 'No relevant evidence found. The answer should be treated as low confidence.');
    }

    return {
        evidence: ranked,
        warnings,
        usedContext: Array.from(usedContext),
    };
}
