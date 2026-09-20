/** Node/V8 synthetic CPU benchmark; not a browser or device performance claim. */
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { DisplaySnapshotCache } from "../packages/client/src/lib/displaySnapshotCache.js";
import type { SessionDisplaySnapshot } from "../packages/shared/src/index.js";

class PreviousCache {
  snapshots = new Map<string, SessionDisplaySnapshot>();
  set(key: string, snapshot: SessionDisplaySnapshot) {
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    let bytes = 0;
    for (const value of this.snapshots.values())
      bytes += JSON.stringify(value).length * 2;
    while (this.snapshots.size > 5 || bytes > 32 * 1024 * 1024) {
      const first = this.snapshots.entries().next().value;
      if (!first) break;
      bytes -= JSON.stringify(first[1]).length * 2;
      this.snapshots.delete(first[0]);
    }
  }
}

function measure(run: () => void) {
  for (let i = 0; i < 20; i++) run();
  const times = Array.from({ length: 100 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return {
    medianMs: Number(times[50]?.toFixed(3)),
    p95Ms: Number(times[95]?.toFixed(3)),
  };
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    samples: 100,
    warmup: 20,
  }),
);
for (const count of [128, 512, 2048]) {
  const snapshot: SessionDisplaySnapshot = {
    version: 2,
    view: { sessionId: "benchmark", branchScopeId: "active", epoch: "e1" },
    seq: 0,
    nodes: Array.from({ length: count }, (_, i) => ({
      type: "question",
      id: `q${i}`,
      turnId: `turn:${i}`,
      question: { messageId: `u${i}`, content: "x".repeat(1024) },
    })),
    activity: { state: "running", tools: [], runningCount: 0 },
  };
  const estimatedMiB = Number(
    ((JSON.stringify(snapshot).length * 2) / 1024 / 1024).toFixed(3),
  );
  console.log(
    JSON.stringify({
      estimatedMiB,
      operation: "active snapshot stringify",
      ...measure(() => {
        JSON.stringify(snapshot);
      }),
    }),
  );
  for (const entries of [1, 5]) {
    for (const [name, Cache] of [
      ["before", PreviousCache],
      ["after", DisplaySnapshotCache],
    ] as const) {
      const cache = new Cache();
      for (let i = 0; i < entries; i++)
        cache.set(String(i), {
          ...snapshot,
          view: { ...snapshot.view, sessionId: String(i) },
        });
      let seq = 0;
      console.log(
        JSON.stringify({
          estimatedMiB,
          entries,
          operation: name,
          ...measure(() => cache.set("0", { ...snapshot, seq: ++seq })),
        }),
      );
    }
  }
}
