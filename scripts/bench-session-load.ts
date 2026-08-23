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
import { gzipSync } from "node:zlib";

import type { UrlProjectId } from "@yep-anywhere/shared";
import { CodexAppServerHistoryReader } from "../packages/server/src/codex-history/CodexAppServerHistoryReader.js";
import { CodexHistoryClient } from "../packages/server/src/codex-history/CodexHistoryClient.js";
import { findCodexCliPath } from "../packages/server/src/sdk/cli-detection.js";
import { CodexSessionReader } from "../packages/server/src/sessions/codex-reader.js";
import { readCodexRolloutFirstLine } from "../packages/server/src/sessions/codex-rollout-file.js";
import { normalizeSession } from "../packages/server/src/sessions/normalization.js";

interface Phase {
  label: string;
  ms: number;
  detail?: string;
}

type ReaderMode = "rollout" | "app-server" | "both";

function parseArgs(argv: string[]): {
  sessionId?: string;
  largest: boolean;
  runs: number;
  window: number;
  reader: ReaderMode;
} {
  const sessionId = argv[0]?.startsWith("--") ? undefined : argv[0];
  const largest = argv.includes("--largest");
  if (!sessionId && !largest) {
    console.error(
      "Usage: npx tsx scripts/bench-session-load.ts <sessionId>|--largest [--runs N] [--window N] [--reader rollout|app-server|both]",
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

  const readerArgument = argv.find((argument) =>
    argument.startsWith("--reader="),
  );
  const reader = (readerArgument?.slice("--reader=".length) ??
    "rollout") as ReaderMode;
  if (!(["rollout", "app-server", "both"] as const).includes(reader)) {
    throw new RangeError(`Unsupported --reader value: ${reader}`);
  }

  return {
    sessionId,
    largest,
    runs: readNumber("--runs", 3),
    window: readNumber("--window", 100),
    reader,
  };
}

async function findLargestRolloutFile(): Promise<string> {
  const root = join(homedir(), ".codex", "sessions");
  const files = execFileSync(
    "find",
    [root, "-name", "*.jsonl*", "-type", "f"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const candidates = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      bytes: await stat(filePath)
        .then((value) => value.size)
        .catch(() => -1),
    })),
  );
  candidates.sort((left, right) => right.bytes - left.bytes);
  for (const candidate of candidates) {
    const metadata = await rolloutMetadata(candidate.filePath);
    if (metadata.historyMode === "paginated" && metadata.sessionId) {
      return candidate.filePath;
    }
  }
  throw new Error("No paginated Codex rollout files found");
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
  if (!file) {
    throw new Error(
      `No rollout file found for session hash ${pathHash(sessionId)}`,
    );
  }
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
  console.log(`run ${run} (${run === 1 ? "cold" : "warm"}):`);
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

function responseSize(value: unknown): {
  jsonBytes: number;
  gzipBytes: number;
} {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  return { jsonBytes: json.byteLength, gzipBytes: gzipSync(json).byteLength };
}

function sameIds(
  left: Array<string | undefined>,
  right: Array<string | undefined>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function rolloutMetadata(
  filePath: string,
): Promise<{ historyMode: string; cwd: string; sessionId?: string }> {
  const firstLine = await readCodexRolloutFirstLine(filePath, 1024 * 1024);
  if (!firstLine) return { historyMode: "unknown", cwd: process.cwd() };
  try {
    const entry = JSON.parse(firstLine) as {
      payload?: {
        id?: string;
        history_mode?: string;
        historyMode?: string;
        cwd?: string;
      };
    };
    return {
      historyMode:
        entry.payload?.history_mode ?? entry.payload?.historyMode ?? "legacy",
      cwd: entry.payload?.cwd ?? process.cwd(),
      sessionId: entry.payload?.id,
    };
  } catch {
    return { historyMode: "unknown", cwd: process.cwd() };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { runs, window, reader: readerMode } = args;
  let appServer: CodexHistoryClient | null = null;
  let appHistoryReader: CodexAppServerHistoryReader | null = null;
  let appServerCommand: string | null = null;
  if (readerMode === "app-server" || readerMode === "both") {
    const command = process.env.CODEX_PATH ?? (await findCodexCliPath());
    if (!command) {
      throw new Error("Codex CLI not found; set CODEX_PATH for app-server A/B");
    }
    appServerCommand = command;
  }

  // Selection is deliberately rollout-metadata-only. No history client exists
  // yet, so the first timed app-server read includes process startup and
  // initialize instead of reporting a pre-warmed lookup as "cold".
  const filePath = args.largest
    ? await findLargestRolloutFile()
    : findRolloutFile(args.sessionId as string);
  const stats = await stat(filePath);
  const reader = new CodexSessionReader({
    sessionsDir: join(homedir(), ".codex", "sessions"),
  });
  const projectId = "bench" as UrlProjectId;
  const rollout = await rolloutMetadata(filePath);
  const sessionId = args.sessionId ?? rollout.sessionId;
  if (!sessionId) throw new Error("Largest rollout has no public session id");

  console.log(`sessionHash: ${pathHash(sessionId)}`);
  console.log(`pathHash: ${pathHash(filePath)}`);
  console.log(`size:     ${(stats.size / 1e6).toFixed(1)} MB`);
  console.log(`historyMode: ${rollout.historyMode}`);
  console.log(`reader:   ${readerMode}`);
  console.log(`window:   ${window} messages`);
  console.log("");

  try {
    for (let run = 1; run <= runs; run += 1) {
      const phases: Phase[] = [];

      if (readerMode === "rollout" || readerMode === "both") {
        let started = performance.now();
        const summary = await reader.getSessionSummary(sessionId, projectId);
        phases.push({
          label: "rollout streaming summary",
          ms: performance.now() - started,
          detail: summary
            ? `messages=${summary.messageCount} compactions=${summary.compactCount ?? 0}`
            : "unavailable",
        });

        started = performance.now();
        const loaded = await reader.getSession(
          sessionId,
          projectId,
          undefined,
          {
            maxMessages: window,
            tailCompactions: 2,
          },
        );
        phases.push({
          label: "rollout bounded detail",
          ms: performance.now() - started,
          detail: loaded
            ? `entries=${loaded.data.session.entries.length} returned=${loaded.pagination?.returnedMessageCount ?? 0} total=${loaded.pagination?.totalMessageCount ?? 0}`
            : "unavailable",
        });

        started = performance.now();
        const normalized = loaded ? normalizeSession(loaded) : null;
        const size = responseSize(normalized?.messages ?? []);
        phases.push({
          label: "normalize rollout page",
          ms: performance.now() - started,
          detail: `messages=${normalized?.messages.length ?? 0} json=${Math.round(size.jsonBytes / 1024)}KiB gzip=${Math.round(size.gzipBytes / 1024)}KiB`,
        });
      }

      if (appServerCommand) {
        let started = performance.now();
        const isFirstAppServerRead = appServer === null;
        if (!appServer) {
          appServer = new CodexHistoryClient({
            command: appServerCommand,
            cwd: process.cwd(),
          });
          appHistoryReader = new CodexAppServerHistoryReader({
            client: appServer,
          });
        }
        const productRead = await appHistoryReader.getSession(
          sessionId,
          projectId,
          rollout.cwd,
          undefined,
          { maxMessages: window, tailCompactions: 2 },
        );
        const productReadMs = performance.now() - started;
        if (productRead.kind !== "loaded") {
          const diagnostic = appServer.getLastFailureDiagnostic();
          phases.push({
            label: isFirstAppServerRead
              ? "app-server initialize + first read"
              : "app-server warm read",
            ms: productReadMs,
            detail: `fallback=${productRead.reason}${diagnostic ? ` method=${diagnostic.method} code=${diagnostic.code ?? "unknown"} category=${diagnostic.category}` : ""}`,
          });
        } else {
          const normalized = normalizeSession(productRead.session);
          const size = responseSize(normalized.messages);
          phases.push({
            label: isFirstAppServerRead
              ? "app-server initialize + first read"
              : "app-server warm read",
            ms: productReadMs,
            detail: `messages=${normalized.messages.length} json=${Math.round(size.jsonBytes / 1024)}KiB gzip=${Math.round(size.gzipBytes / 1024)}KiB`,
          });
          const olderCursor =
            productRead.session.pagination?.truncatedBeforeMessageId;
          if (olderCursor) {
            started = performance.now();
            const older = await appHistoryReader.getSession(
              sessionId,
              projectId,
              rollout.cwd,
              undefined,
              { maxMessages: window, beforeMessageId: olderCursor },
            );
            const newerCursor =
              older.kind === "loaded"
                ? older.session.pagination?.truncatedAfterMessageId
                : undefined;
            const newer = newerCursor
              ? await appHistoryReader.getSession(
                  sessionId,
                  projectId,
                  rollout.cwd,
                  undefined,
                  { maxMessages: window, afterWindowMessageId: newerCursor },
                )
              : null;
            const roundTripCursor =
              newer?.kind === "loaded"
                ? newer.session.pagination?.truncatedBeforeMessageId
                : undefined;
            const roundTrip = roundTripCursor
              ? await appHistoryReader.getSession(
                  sessionId,
                  projectId,
                  rollout.cwd,
                  undefined,
                  { maxMessages: window, beforeMessageId: roundTripCursor },
                )
              : null;
            const olderIds =
              older.kind === "loaded"
                ? (older.session.projectedMessages ?? []).map(
                    (message) => message.uuid,
                  )
                : [];
            const newerIds =
              newer?.kind === "loaded"
                ? (newer.session.projectedMessages ?? []).map(
                    (message) => message.uuid,
                  )
                : [];
            const roundTripIds =
              roundTrip?.kind === "loaded"
                ? (roundTrip.session.projectedMessages ?? []).map(
                    (message) => message.uuid,
                  )
                : [];
            const size = responseSize({
              older:
                older.kind === "loaded" ? older.session.projectedMessages : [],
              newer:
                newer?.kind === "loaded" ? newer.session.projectedMessages : [],
            });
            phases.push({
              label: "app-server older/newer roundtrip",
              ms: performance.now() - started,
              detail: `older=${olderIds.length} newer=${newerIds.length} boundaryOverlap=${olderIds.some((id) => newerIds.includes(id))} roundTrip=${sameIds(olderIds, roundTripIds)} json=${Math.round(size.jsonBytes / 1024)}KiB gzip=${Math.round(size.gzipBytes / 1024)}KiB`,
            });
          }
        }
      }

      report(run, phases);
    }
  } finally {
    appServer?.shutdown();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
