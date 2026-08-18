#!/usr/bin/env npx tsx

/**
 * Read-only benchmark for the bounded Codex rollout reader.
 *
 * It exercises the same summary and paginated detail paths used by Yep rather
 * than the old `readFile -> split -> entries[]` reference path. The benchmark
 * intentionally reports a path hash instead of a local path and never contacts
 * or restarts a running service.
 *
 * Usage:
 *   npx tsx scripts/bench-session-load.ts <sessionId> [--runs N] [--window N]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UrlProjectId } from "@yep-anywhere/shared";
import { CodexSessionReader } from "../packages/server/src/sessions/codex-reader.js";
import { normalizeSession } from "../packages/server/src/sessions/normalization.js";

interface Phase {
  label: string;
  ms: number;
  detail?: string;
}

function parseArgs(argv: string[]): {
  sessionId: string;
  runs: number;
  window: number;
} {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const sessionId = positional[0];
  if (!sessionId) {
    console.error(
      "Usage: npx tsx scripts/bench-session-load.ts <sessionId> [--runs N] [--window N]",
    );
    process.exit(1);
  }

  const readNumber = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    if (index < 0) return fallback;
    const value = Number.parseInt(argv[index + 1] ?? "", 10);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${flag} must be a positive integer`);
    }
    return value;
  };

  return {
    sessionId,
    runs: readNumber("--runs", 3),
    window: readNumber("--window", 100),
  };
}

function findRolloutFile(sessionId: string): string {
  const root = join(homedir(), ".codex", "sessions");
  const matches = execFileSync(
    "find",
    [root, "-name", `*${sessionId}*.jsonl*`, "-type", "f"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const file = matches[0];
  if (!file) throw new Error(`No rollout file found for session ${sessionId}`);
  return file;
}

function pathHash(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function memoryDetail(): string {
  const memory = process.memoryUsage();
  return [
    `rss=${Math.round(memory.rss / 1024 / 1024)}MiB`,
    `heap=${Math.round(memory.heapUsed / 1024 / 1024)}MiB`,
    `external=${Math.round(memory.external / 1024 / 1024)}MiB`,
    `arrayBuffers=${Math.round(memory.arrayBuffers / 1024 / 1024)}MiB`,
  ].join(" ");
}

function report(run: number, phases: Phase[]): void {
  console.log(`run ${run}:`);
  let total = 0;
  for (const phase of phases) {
    total += phase.ms;
    const detail = phase.detail ? `  (${phase.detail})` : "";
    console.log(
      `  ${phase.ms.toFixed(0).padStart(6)} ms  ${phase.label}${detail}`,
    );
  }
  console.log(`  ${total.toFixed(0).padStart(6)} ms  TOTAL`);
  console.log(`  memory: ${memoryDetail()}`);
  console.log("");
}

async function main(): Promise<void> {
  const { sessionId, runs, window } = parseArgs(process.argv.slice(2));
  const filePath = findRolloutFile(sessionId);
  const stats = await stat(filePath);
  const reader = new CodexSessionReader({
    sessionsDir: join(homedir(), ".codex", "sessions"),
  });
  const projectId = "bench" as UrlProjectId;

  console.log(`session:  ${sessionId}`);
  console.log(`pathHash: ${pathHash(filePath)}`);
  console.log(`size:     ${(stats.size / 1e6).toFixed(1)} MB`);
  console.log(`window:   ${window} messages`);
  console.log("");

  for (let run = 1; run <= runs; run += 1) {
    const phases: Phase[] = [];

    let started = performance.now();
    const summary = await reader.getSessionSummary(sessionId, projectId);
    phases.push({
      label: "streaming summary",
      ms: performance.now() - started,
      detail: summary
        ? `messages=${summary.messageCount} compactions=${summary.compactCount ?? 0}`
        : "unavailable",
    });

    started = performance.now();
    const loaded = await reader.getSession(sessionId, projectId, undefined, {
      maxMessages: window,
      tailCompactions: 2,
    });
    phases.push({
      label: "bounded detail reader",
      ms: performance.now() - started,
      detail: loaded
        ? `entries=${loaded.data.session.entries.length} returned=${loaded.pagination?.returnedMessageCount ?? 0} total=${loaded.pagination?.totalMessageCount ?? 0}`
        : "unavailable",
    });

    started = performance.now();
    const normalized = loaded ? normalizeSession(loaded) : null;
    const serializedBytes = normalized
      ? Buffer.byteLength(JSON.stringify(normalized.messages), "utf8")
      : 0;
    phases.push({
      label: "normalize bounded page",
      ms: performance.now() - started,
      detail: `messages=${normalized?.messages.length ?? 0} json=${Math.round(serializedBytes / 1024)}KiB`,
    });

    report(run, phases);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
