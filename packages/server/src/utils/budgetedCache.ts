interface BudgetEntry {
  evict(): void;
}

/**
 * One byte budget shared by many caches, evicting least-recently-used entries
 * across all of them. Per-cache limits do not bound memory when the caches
 * themselves are created per project.
 */
export class SharedByteBudget {
  private readonly order = new Map<BudgetEntry, number>();
  private total = 0;

  constructor(readonly maxBytes: number) {}

  get usedBytes(): number {
    return this.total;
  }

  touch(entry: BudgetEntry): void {
    const bytes = this.order.get(entry);
    if (bytes === undefined) return;
    this.order.delete(entry);
    this.order.set(entry, bytes);
  }

  add(entry: BudgetEntry, bytes: number): void {
    this.remove(entry);
    this.order.set(entry, bytes);
    this.total += bytes;
    while (this.total > this.maxBytes) {
      const oldest = this.order.keys().next();
      if (oldest.done) break;
      oldest.value.evict();
      // Progress must not depend on evict() calling back into remove().
      this.remove(oldest.value);
    }
  }

  remove(entry: BudgetEntry): void {
    const bytes = this.order.get(entry);
    if (bytes === undefined) return;
    this.order.delete(entry);
    this.total -= bytes;
  }
}

/** A Map-like cache whose entries are charged against a shared budget. */
export class BudgetedCache<V> {
  private readonly map = new Map<string, { value: V; entry: BudgetEntry }>();

  constructor(private readonly budget: SharedByteBudget) {}

  get(key: string): V | undefined {
    const cached = this.map.get(key);
    if (!cached) return undefined;
    this.budget.touch(cached.entry);
    return cached.value;
  }

  /** Values larger than a quarter of the budget are not retained. */
  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.budget.maxBytes / 4) return;
    const entry: BudgetEntry = { evict: () => this.map.delete(key) };
    this.map.set(key, { value, entry });
    this.budget.add(entry, bytes);
  }

  delete(key: string): boolean {
    const cached = this.map.get(key);
    if (!cached) return false;
    this.map.delete(key);
    this.budget.remove(cached.entry);
    return true;
  }

  clear(): void {
    for (const key of [...this.map.keys()]) this.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  *[Symbol.iterator](): IterableIterator<[string, V]> {
    for (const [key, cached] of this.map) yield [key, cached.value];
  }
}
