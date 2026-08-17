#!/usr/bin/env npx tsx

/**
 * Phase-level load benchmark for one real Codex session rollout file.
 *
 * Answers "where does the wall time go when opening a very large session?" by
 * timing the exact stages the HTTP read path runs on every request:
 *
 *   1. readFile + split          raw I/O
 *   2. parseCodexSessionEntry    schema parse per line
 *   3. buildCodexBranchView      branch projection over all entries
 *   4. convertCodexEntries       provider entries -> canonical Message[]
 *   5. JSON.stringify            response serialization (full + windowed)
 *
 * Read-only: never writes session files, never contacts a running server.
 *
 * Usage:
 *   npx tsx scripts/bench-session-load.ts <sessionId> [--runs N] [--window N]
 */

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildCodexBranchView } from "../packages/server/src/sessions/codex-rollback.js";
import { convertCodexEntries } from "../packages/server/src/sessions/normalization.js";
import { parseCodexSessionEntry } from "../packages/shared/src/codex-schema/session.js";

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
  const positional = argv.filter((a) => !a.startsWith("--"));
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
    [root, "-name", `*${sessionId}*.jsonl`, "-type", "f"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const file = matches[0];
  if (!file) throw new Error(`No rollout file found for session ${sessionId}`);
  return file;
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
  console.log("");
}

async function main(): Promise<void> {
  const { sessionId, runs, window } = parseArgs(process.argv.slice(2));
  const filePath = findRolloutFile(sessionId);
  const stats = await stat(filePath);

  console.log(`session: ${sessionId}`);
  console.log(`file:    ${filePath}`);
  console.log(`size:    ${(stats.size / 1e6).toFixed(1)} MB`);
  console.log(`window:  last ${window} messages`);
  console.log("");

  for (let run = 1; run <= runs; run++) {
    const phases: Phase[] = [];

    let t = performance.now();
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");
    phases.push({
      label: "readFile + split",
      ms: performance.now() - t,
      detail: `${lines.length} lines`,
    });

    t = performance.now();
    const entries = [];
    for (const line of lines) {
      if (!line) continue;
      const entry = parseCodexSessionEntry(line);
      if (entry) entries.push(entry);
    }
    phases.push({
      label: "parseCodexSessionEntry",
      ms: performance.now() - t,
      detail: `${entries.length} entries`,
    });

    // The read path builds the branch view twice today: once inside
    // buildSummaryFromEntries and once for the requested branch. Time a single
    // call so the doubled cost is explicit in the totals below.
    t = performance.now();
    const branchView = buildCodexBranchView(entries, sessionId);
    phases.push({
      label: "buildCodexBranchView x1",
      ms: performance.now() - t,
      detail: `${branchView.entries.length} visible entries`,
    });

    t = performance.now();
    const messages = convertCodexEntries(
      branchView.entries,
      sessionId,
      branchView.branchState,
    );
    phases.push({
      label: "convertCodexEntries",
      ms: performance.now() - t,
      detail: `${messages.length} messages`,
    });

    t = performance.now();
    const fullJson = JSON.stringify(messages);
    phases.push({
      label: "JSON.stringify (all messages)",
      ms: performance.now() - t,
      detail: `${(fullJson.length / 1e6).toFixed(1)} MB`,
    });

    t = performance.now();
    const windowJson = JSON.stringify(messages.slice(-window));
    phases.push({
      label: `JSON.stringify (window ${window})`,
      ms: performance.now() - t,
      detail: `${(windowJson.length / 1e6).toFixed(3)} MB`,
    });

    report(run, phases);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
