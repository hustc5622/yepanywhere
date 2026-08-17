#!/usr/bin/env npx tsx

/**
 * Verify that a session-open burst shares one rollout read.
 *
 * Opening a session fans out into several reader calls. Because
 * `readSharedCodexEntries` only coalesces reads that overlap in time, this
 * script gets a same-process A/B for free:
 *
 *   serial     each call reads + parses the file on its own  (old behaviour)
 *   concurrent the burst shares a single read + parse        (new behaviour)
 *
 * Read-only: it never writes session files and never contacts a running server.
 *
 * Usage:
 *   npx tsx scripts/verify-session-open-burst.ts <sessionId> [--runs N]
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { CodexSessionReader } from "../packages/server/src/sessions/codex-reader.js";
import type { UrlProjectId } from "../packages/shared/src/index.js";

function parseArgs(argv: string[]): { sessionId: string; runs: number } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const sessionId = positional[0];
  if (!sessionId) {
    console.error(
      "Usage: npx tsx scripts/verify-session-open-burst.ts <sessionId> [--runs N]",
    );
    process.exit(1);
  }
  const index = argv.indexOf("--runs");
  const runs = index >= 0 ? Number.parseInt(argv[index + 1] ?? "", 10) : 3;
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new RangeError("--runs must be a positive integer");
  }
  return { sessionId, runs };
}

async function main(): Promise<void> {
  const { sessionId, runs } = parseArgs(process.argv.slice(2));
  const sessionsDir = join(homedir(), ".codex", "sessions");
  const reader = new CodexSessionReader({ sessionsDir });

  // The route layer derives the project id from the session's own cwd; for a
  // timing harness any well-formed id works because the reader only uses it to
  // stamp the returned summary.
  const summary = await reader.getSessionSummary(
    sessionId,
    "bench" as UrlProjectId,
  );
  if (!summary) {
    throw new Error(`Session ${sessionId} not found under ${sessionsDir}`);
  }
  const projectId = summary.projectId;

  // Thunks, not promises: calling the reader eagerly would start every request
  // immediately and make the "serial" arm concurrent too.
  const burst = (): Array<() => Promise<unknown>> => [
    () => reader.getSession(sessionId, projectId, undefined, {}),
    () => reader.getSessionSummary(sessionId, projectId),
    () => reader.getAgentMappings(sessionId),
  ];

  console.log(`session: ${sessionId}`);
  console.log("calls:   getSession + getSessionSummary + getAgentMappings");
  console.log("");

  for (let run = 1; run <= runs; run++) {
    let t = performance.now();
    for (const call of burst()) await call();
    const serialMs = performance.now() - t;

    t = performance.now();
    await Promise.all(burst().map((call) => call()));
    const concurrentMs = performance.now() - t;

    const saved = ((1 - concurrentMs / serialMs) * 100).toFixed(0);
    console.log(
      `run ${run}:  serial ${serialMs.toFixed(0)} ms  ->  concurrent ${concurrentMs.toFixed(0)} ms  (-${saved}%)`,
    );
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
