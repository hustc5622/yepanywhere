#!/usr/bin/env npx tsx

/**
 * Synthetic benchmark for canonical Codex overlay performance.
 *
 * Generates synthetic events (no real prompts, tool outputs, or paths) at
 * scales 100 / 1k / 2k / 5k / 10k / 20k, then measures:
 *   - cold reduce duration (no cache)
 *   - warm cache incremental apply (single new event)
 *   - total overlay (with cache, cold start)
 *   - total overlay (with cache, warm hit)
 *   - budget exceeded test
 *   - RSS/heap delta
 *   - projection parity hash
 *
 * Usage:
 *   npx tsx scripts/bench-codex-overlay.ts
 *   npx tsx scripts/bench-codex-overlay.ts --max 10000
 */

import { createHash as nodeCreateHash } from "node:crypto";
import { memoryUsage } from "node:process";
import {
  type CodexEventDraft,
  type CodexEventEnvelope,
  CodexOverlayBudgetExceededError,
  CodexProjectionCache,
  InMemoryCodexEventStore,
  createCanonicalCodexSessionState,
  overlayCanonicalCodexSessionMessages,
  reduceCodexEvents,
  safeCodexPayload,
} from "../packages/server/src/codex-events/index.js";

const SESSION_ID = "bench-session";
const THREAD_ID = "bench-thread";
const TURN_ID = "bench-turn";
const SOURCE_ID = "bench";

interface BenchResult {
  eventCount: number;
  coldReduceMs: number;
  warmApplyMs: number;
  overlayColdMs: number;
  overlayWarmMs: number;
  rssDeltaBytes: number;
  heapDeltaBytes: number;
  projectionHash: string;
}

function main(): void {
  const args = process.argv.slice(2);
  let maxEvents = 20_000;
  const maxIdx = args.indexOf("--max");
  if (maxIdx !== -1 && args[maxIdx + 1]) {
    const parsedMax = Number.parseInt(args[maxIdx + 1], 10);
    if (!Number.isSafeInteger(parsedMax) || parsedMax < 1) {
      throw new RangeError("--max must be a positive integer");
    }
    maxEvents = parsedMax;
  }

  const scales = [100, 1_000, 2_000, 5_000, 10_000, 20_000].filter(
    (n) => n <= maxEvents,
  );

  console.log("Codex canonical overlay synthetic benchmark");
  console.log("=============================================");
  console.log(`Scales: ${scales.join(", ")}`);
  console.log();

  const results: BenchResult[] = [];
  for (const scale of scales) {
    const result = benchScale(scale);
    results.push(result);
    printResult(result);
  }

  console.log();
  console.log("Scaling summary:");
  for (const result of results) {
    console.log(
      `  ${String(result.eventCount).padStart(6)} events -> cold overlay ${result.overlayColdMs.toFixed(1)} ms, warm overlay ${result.overlayWarmMs.toFixed(2)} ms, warm apply ${result.warmApplyMs.toFixed(3)} ms`,
    );
  }

  // Budget exceeded test
  console.log();
  console.log("Budget exceeded test:");
  testBudget(Math.min(maxEvents, 10_000));

  console.log();
  console.log("Windowed candidate construction test:");
  testWindow(maxEvents);
}

function testWindow(maxEvents: number): void {
  const scales = [10_000, 20_000].filter((n) => n <= maxEvents);
  if (scales.length === 0 && maxEvents > 0) scales.push(maxEvents);
  for (const n of scales) {
    const events = generateSyntheticEvents(n);
    const cache = new CodexProjectionCache();
    cache.apply(SOURCE_ID, SESSION_ID, events);

    // Without windowing
    const t0 = performance.now();
    overlayCanonicalCodexSessionMessages(SESSION_ID, [], events, {
      sourceId: SOURCE_ID,
      projectionCache: cache,
    });
    const t1 = performance.now();

    // With windowing (last 100 items)
    const t2 = performance.now();
    overlayCanonicalCodexSessionMessages(SESSION_ID, [], events, {
      sourceId: SOURCE_ID,
      projectionCache: cache,
      maxCandidateCount: 100,
    });
    const t3 = performance.now();

    console.log(
      `  ${n} events: no window=${(t1 - t0).toFixed(1)} ms, window(100)=${(t3 - t2).toFixed(1)} ms`,
    );
  }
}

function benchScale(eventCount: number): BenchResult {
  const events = generateSyntheticEvents(eventCount);
  const beforeRss = memoryUsage().rss;
  const beforeHeap = memoryUsage().heapUsed;

  // Cold reduce (no cache)
  const coldStart = performance.now();
  const coldProjection = reduceCodexEvents(
    createCanonicalCodexSessionState(SESSION_ID),
    events,
  );
  const coldReduceMs = performance.now() - coldStart;
  const coldHash = stableHash(coldProjection);

  // Warm cache: prime with all events, then apply one new event
  const cache = new CodexProjectionCache();
  cache.apply(SOURCE_ID, SESSION_ID, events);
  const extraEvent = generateSyntheticEvents(1, eventCount + 1)[0];
  let warmApplyMs = 0;
  if (extraEvent) {
    const warmStart = performance.now();
    cache.apply(
      SOURCE_ID,
      SESSION_ID,
      [extraEvent, ...events].sort((a, b) => a.sequence - b.sequence),
    );
    warmApplyMs = performance.now() - warmStart;
  }

  // Cold overlay (fresh cache, full replay via apply)
  const coldCache = new CodexProjectionCache();
  const overlayColdStart = performance.now();
  overlayCanonicalCodexSessionMessages(SESSION_ID, [], events, {
    sourceId: SOURCE_ID,
    projectionCache: coldCache,
  });
  const overlayColdMs = performance.now() - overlayColdStart;

  // Warm overlay (cache already primed)
  const overlayWarmStart = performance.now();
  overlayCanonicalCodexSessionMessages(SESSION_ID, [], events, {
    sourceId: SOURCE_ID,
    projectionCache: cache,
  });
  const overlayWarmMs = performance.now() - overlayWarmStart;

  const afterRss = memoryUsage().rss;
  const afterHeap = memoryUsage().heapUsed;

  return {
    eventCount,
    coldReduceMs,
    warmApplyMs,
    overlayColdMs,
    overlayWarmMs,
    rssDeltaBytes: afterRss - beforeRss,
    heapDeltaBytes: afterHeap - beforeHeap,
    projectionHash: coldHash,
  };
}

function testBudget(eventCount: number): void {
  const events = generateSyntheticEvents(eventCount);
  const startedMs = Date.now();
  try {
    overlayCanonicalCodexSessionMessages(SESSION_ID, [], events, {
      sourceId: SOURCE_ID,
      startedMs,
      budgetMs: 0, // immediately exceeded
    });
    console.log("  budget not exceeded (unexpected for budgetMs=0)");
  } catch (error) {
    if (error instanceof CodexOverlayBudgetExceededError) {
      console.log(
        `  budget exceeded correctly: eventCount=${error.eventCount}`,
      );
    } else {
      console.log(`  unexpected error: ${String(error)}`);
    }
  }
}

function generateSyntheticEvents(
  count: number,
  startSequence = 1,
): CodexEventEnvelope[] {
  const events: CodexEventEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = startSequence + i;
    const itemId = `item-${seq}`;
    // Alternate between started/completed/delta to exercise lifecycle paths
    const method =
      i % 3 === 0
        ? "item/started"
        : i % 3 === 1
          ? "item/agentMessage/delta"
          : "item/completed";
    const data: Record<string, unknown> =
      method === "item/started"
        ? {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: { id: itemId, type: "agentMessage" },
            startedAtMs: seq * 1000,
          }
        : method === "item/agentMessage/delta"
          ? {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              itemId,
              delta: `synthetic-delta-${seq}`,
            }
          : {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              item: {
                id: itemId,
                type: "agentMessage",
                text: `synthetic text ${seq}`,
              },
              completedAtMs: seq * 1000 + 500,
            };

    const draft: CodexEventDraft = {
      schema: {
        name: "yep.codex-event",
        version: 1 as const,
      },
      eventId: `evt-${seq}`,
      provider: "codex",
      runtime: {
        codexVersion: "0.147.0",
        schemaHash: "bench",
        profile: "stable",
        experimentalApi: false,
      },
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId,
      correlationId: `bench-${seq}`,
      method,
      direction: "server_notification",
      phase: "observed",
      receivedAtMs: seq * 1000,
      payload: safeCodexPayload(data),
      source: { connectionId: "bench", replay: false },
    };
    events.push({ ...draft, persistedAtMs: seq * 1000 + 1, sequence: seq });
  }
  return events;
}

function stableHash(value: unknown): string {
  return nodeCreateHash("sha256")
    .update(stableSerialize(value))
    .digest("hex")
    .slice(0, 20);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}

function printResult(r: BenchResult): void {
  console.log(`--- ${r.eventCount} events ---`);
  console.log(`  cold reduce:    ${r.coldReduceMs.toFixed(1)} ms`);
  console.log(`  warm apply:     ${r.warmApplyMs.toFixed(3)} ms`);
  console.log(`  overlay cold:   ${r.overlayColdMs.toFixed(1)} ms`);
  console.log(`  overlay warm:   ${r.overlayWarmMs.toFixed(2)} ms`);
  console.log(
    `  RSS delta:      ${(r.rssDeltaBytes / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log(
    `  heap delta:     ${(r.heapDeltaBytes / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log(`  projection hash: ${r.projectionHash}`);
  console.log();
}

main();
