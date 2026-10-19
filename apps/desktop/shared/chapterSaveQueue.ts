/** Serial writes with retained failed snapshots, so export can drain and retry them. */
export class ChapterSaveQueue {
    private tail: Promise<unknown> = Promise.resolve();
    private pending = new Map<string, () => Promise<void>>();

    enqueue(key: string, write: () => Promise<void>): Promise<void> {
        this.pending.set(key, write);
        const task = this.tail.then(async () => {
            if (!this.pending.has(key)) return;
            await write();
            if (this.pending.get(key) === write) this.pending.delete(key);
        });
        this.tail = task.catch(() => undefined);
        return task;
    }

    has(key: string): boolean { return this.pending.has(key); }
    discard(key: string): void { this.pending.delete(key); }

    async flush(): Promise<void> {
        await this.tail;
        for (const [key, write] of [...this.pending]) {
            if (this.pending.get(key) === write) await this.enqueue(key, write);
        }
        await this.tail;
    }
}

// Survives editor unmounts when returning to the library with a write in flight.
const queues = new Map<string, ChapterSaveQueue>();
export function chapterSaveQueue(novelId: string): ChapterSaveQueue {
    let queue = queues.get(novelId);
    if (!queue) { queue = new ChapterSaveQueue(); queues.set(novelId, queue); }
    return queue;
}
export async function flushChapterSaves(novelId: string): Promise<void> {
    await queues.get(novelId)?.flush();
}
