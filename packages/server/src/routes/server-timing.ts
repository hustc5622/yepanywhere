const SERVER_TIMING_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Small request-local Server-Timing accumulator.
 *
 * Metric names are fixed by the caller and values are durations only. Keeping
 * descriptions out of the header prevents project paths, session IDs, or
 * transcript content from leaking through performance diagnostics.
 */
export class ServerTimingRecorder<TName extends string> {
  private readonly durations = new Map<TName, number>();

  constructor(private readonly names: readonly TName[]) {
    for (const name of names) {
      if (!SERVER_TIMING_TOKEN.test(name)) {
        throw new Error(`Invalid Server-Timing metric name: ${name}`);
      }
      this.durations.set(name, 0);
    }
  }

  async measure<T>(name: TName, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.add(name, performance.now() - startedAt);
    }
  }

  measureSync<T>(name: TName, operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.add(name, performance.now() - startedAt);
    }
  }

  add(name: TName, durationMs: number | undefined): void {
    if (durationMs === undefined || !Number.isFinite(durationMs)) return;
    const current = this.durations.get(name) ?? 0;
    this.durations.set(name, current + Math.max(0, durationMs));
  }

  set(name: TName, durationMs: number | undefined): void {
    if (durationMs === undefined || !Number.isFinite(durationMs)) return;
    this.durations.set(name, Math.max(0, durationMs));
  }

  headerValue(): string {
    return this.names
      .map(
        (name) => `${name};dur=${(this.durations.get(name) ?? 0).toFixed(1)}`,
      )
      .join(", ");
  }
}
