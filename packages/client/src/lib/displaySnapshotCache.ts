import type { SessionDisplaySnapshot } from "@yep-anywhere/shared";

/** Snapshots are immutable. Account only for the replaced entry on each patch. */
export class DisplaySnapshotCache {
  private readonly entries = new Map<
    string,
    { snapshot: SessionDisplaySnapshot; bytes: number }
  >();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntries = 5,
  ) {}

  get(key: string): SessionDisplaySnapshot | undefined {
    return this.entries.get(key)?.snapshot;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, snapshot: SessionDisplaySnapshot): void {
    // Keep the existing UTF-16 JSON estimate and write-recency eviction policy.
    // Measure first so a failed serialization cannot corrupt the accounting.
    const bytes = JSON.stringify(snapshot).length * 2;
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
    this.entries.set(key, { snapshot, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.entries.entries().next().value;
      if (!first) break;
      this.bytes -= first[1].bytes;
      this.entries.delete(first[0]);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
