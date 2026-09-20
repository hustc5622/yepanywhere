/** Bounded, versioned file-index reads. In-flight work belongs to one version. */
export class FileIndexCache<T> {
  private readonly entries = new Map<
    string,
    { stamp: string; value: Promise<T> }
  >();

  constructor(private readonly limit: number) {}

  get(key: string, stamp: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached?.stamp === stamp) return cached.value;

    // Publish the promise before loading, so concurrent cold readers share work.
    // Completion never writes back: a superseded read cannot replace a newer one.
    const entry = { stamp, value: Promise.resolve().then(load) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    void entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }
}
