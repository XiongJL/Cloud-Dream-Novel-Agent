// Deliberately explicit: a newly persisted domain must be classified before it can
// disappear into a supposedly complete backup. Columns are discovered dynamically.
export const BACKUP_TABLES = [
    'Novel', 'Volume', 'Chapter', 'Character', 'Item', 'ItemOwnership', 'WorldSetting',
    'Relationship', 'Idea', 'Tag', '_IdeaToTag', 'PlotLine', 'PlotPoint', 'PlotPointAnchor',
    'MapCanvas', 'MapElement', 'CharacterMapMarker', 'ChapterSummary', 'NarrativeSummary',
    'AgentConversation', 'AgentMessage', 'AgentAttachment', 'AgentRun', 'AgentRunEvent',
    'AgentArtifact', 'AgentRevisionTask', 'AgentModelResultCheckpoint', 'AgentModelRepairAttempt',
    'DraftSession', 'DraftBatch', 'DraftBatchChild', 'DraftGenerationOperation',
    'DraftGenerationAttempt', 'DraftOperationOutbox', 'AgentSkill', 'AgentSkillRevision',
    'AgentSkillBinding', 'AgentSkillDraft', 'AgentSkillPack', 'AgentSkillPackRevision',
    'AgentSkillPackPreference',
] as const;
export const EXCLUDED_TABLES = new Set(['SyncState', 'AppSchemaMigration', '_prisma_migrations', 'rag_vector_chunks']);
const SEARCH_TABLES = new Set(['search_index', 'search_index_data', 'search_index_idx', 'search_index_content', 'search_index_docsize', 'search_index_config']);
export function excludedTable(name: string): boolean {
    return EXCLUDED_TABLES.has(name) || name.startsWith('sqlite_') || SEARCH_TABLES.has(name);
}
export function sqlName(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw backupError('REFERENCE_INVALID', '非法的数据表或字段名称');
    return `"${name}"`;
}
export function backupError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}
export interface Column { name: string; type: string; notnull: number; pk: number; dflt_value: unknown }
export interface BackupDatabase {
    $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
}
export async function tableCatalog(database: BackupDatabase): Promise<Record<string, Column[]>> {
    const tables = await database.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const catalog: Record<string, Column[]> = {};
    for (const { name } of tables) {
        if (excludedTable(name)) continue;
        if (!(BACKUP_TABLES as readonly string[]).includes(name)) throw backupError('UNREGISTERED_DOMAIN', `数据表 ${name} 尚未登记备份规则，不能生成完整备份。`);
        const columns = await database.$queryRawUnsafe<Column[]>(`PRAGMA table_info(${sqlName(name)})`);
        catalog[name] = columns.map(column => ({ name: column.name, type: column.type, notnull: Number(column.notnull), pk: Number(column.pk), dflt_value: column.dflt_value }));
    }
    // Missing implicit edges are just as serious as missing entities.
    for (const table of BACKUP_TABLES) {
        if (!catalog[table] && table !== 'AgentSkillPackPreference') throw backupError('UNREGISTERED_DOMAIN', `数据表 ${table} 不存在，请先完成数据库升级。`);
    }
    return catalog;
}
