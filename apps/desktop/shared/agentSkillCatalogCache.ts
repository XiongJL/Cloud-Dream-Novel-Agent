/** Metadata only: execution always rechecks scope and loads locked revisions. */
export class AgentSkillCatalogCache<T> {
  private entries = new Map<string, {value?: T; expires: number; pending?: Promise<T>}>();

  constructor(private ttlMs = 10_000, private now: () => number = Date.now) {}

  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expires > this.now() ? entry.value : undefined;
  }

  invalidate(key: string): void {
    // Detach old requests so a publication/scope change can fetch a fresh catalog.
    this.entries.delete(key);
  }

  clear(): void {
    // Scope changes may affect several novels, including recently visited ones.
    this.entries.clear();
  }

  load(key: string, fetch: () => Promise<T>, cacheable: (value: T) => boolean = () => true): Promise<T> {
    const current = this.entries.get(key);
    if (current?.pending) return current.pending;
    const cached = this.peek(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const entry: {value?: T; expires: number; pending?: Promise<T>} = {expires: 0};
    this.entries.set(key, entry);
    entry.pending = Promise.resolve().then(fetch).then(value => {
      if (this.entries.get(key) === entry) {
        entry.pending = undefined;
        if (cacheable(value)) {
          entry.value = value;
          entry.expires = this.now() + this.ttlMs;
          // Keep a small number of recently visited novels/locales.
          while (this.entries.size > 4) {
            this.entries.delete(this.entries.keys().next().value!);
          }
        } else this.entries.delete(key);
      }
      return value;
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return entry.pending;
  }
}
