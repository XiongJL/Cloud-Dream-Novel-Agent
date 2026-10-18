import { AsyncLocalStorage } from 'node:async_hooks';
import { backupError } from './BackupRegistry';

const task = new AsyncLocalStorage<{ active: boolean }>();
let locked = false;
let sealed = false;
let active = 0;
let lastActivity = Date.now();
export function dataIdleMilliseconds(): number { return active ? 0 : Date.now() - lastActivity; }
export function isDataMaintenance(): boolean { return locked || sealed; }
export function sealDataMaintenance(): void { sealed = true; }
export async function dataOperation<T>(operation: () => Promise<T>, recordsActivity = true): Promise<T> {
    if (sealed || (locked && !task.getStore()?.active)) throw backupError('BUSY', '正在备份或恢复，请稍后再试。');
    active++;
    const context = { active: true };
    try { return await task.run(context, operation); } finally { context.active = false; active--; if (recordsActivity) lastActivity = Date.now(); }
}
export async function exclusiveData<T>(operation: () => Promise<T>): Promise<T> {
    if (locked || sealed) throw backupError('BUSY', '另一个备份或恢复正在进行。');
    locked = true;
    try {
        const deadline = Date.now() + 30000;
        while (active) {
            if (Date.now() > deadline) throw backupError('BUSY', '数据任务尚未结束，请等待后重试。');
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return await operation();
    } finally { locked = false; }
}
