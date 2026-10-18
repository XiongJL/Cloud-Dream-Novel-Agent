import type { BackupAutoInfo } from '../../shared/backup';

/** Newest successful snapshots are protected even when the soft cap is exceeded. */
export function retentionPlan(files: BackupAutoInfo[], now = Date.now(), budget = 2 * 1024 ** 3): { remove: string[]; overBudget: boolean } {
    const valid = files.filter(file => file.valid).sort((a, b) => b.createdAt - a.createdAt);
    const keep = new Set(valid.slice(0, 10).map(file => file.filename));
    const protectedNames = new Set(valid.slice(0, 3).map(file => file.filename));
    const days = new Set<string>(), weeks = new Set<number>();
    for (const file of valid) {
        const day = new Date(file.createdAt).toISOString().slice(0, 10);
        const week = Math.floor(file.createdAt / (7 * 86400000));
        if (file.createdAt >= now - 7 * 86400000 && !days.has(day)) { days.add(day); keep.add(file.filename); }
        if (file.createdAt >= now - 28 * 86400000 && !weeks.has(week)) { weeks.add(week); keep.add(file.filename); }
        if (file.pinned) { keep.add(file.filename); protectedNames.add(file.filename); }
    }
    let size = files.reduce((sum, file) => sum + (file.valid && !keep.has(file.filename) ? 0 : file.size), 0);
    for (const file of [...valid].reverse()) {
        if (size <= budget) break;
        if (keep.has(file.filename) && !protectedNames.has(file.filename)) { keep.delete(file.filename); size -= file.size; }
    }
    return { remove: valid.filter(file => !keep.has(file.filename)).map(file => file.filename), overBudget: size > budget };
}
