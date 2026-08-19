#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import {
  CodexBridgeService,
  type CodexBridgeServiceOptions,
} from "../packages/server/src/codex-bridge/CodexBridgeService.js";
import type { CodexBridgeJournalMode } from "../packages/server/src/codex-bridge/journal-policy.js";
import {
  type CodexEventAppendResult,
  type CodexEventDraft,
  type CodexEventReplayQuery,
  type CodexEventStore,
  JsonlCodexEventStore,
} from "../packages/server/src/codex-events/index.js";

const RESULT_PREFIX = "BENCH_RESULT ";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

interface BenchOptions {
  child: boolean;
  modes: CodexBridgeJournalMode[];
  mode: CodexBridgeJournalMode;
  connections: number[];
  connectionCount: number;
  frames: number;
  legacyFrames: number;
  deltaBytes: number;
  writerDelayMs: number;
  writerFailure: boolean;
  includeSlow: boolean;
}

interface BenchResult {
  label: string;
  mode: CodexBridgeJournalMode;
  buildId: string;
  nodeVersion: string;
  protocolVersion: string;
  connections: number;
  framesPerConnection: number;
  totalFrames: number;
  receivedFrames: number;
  deltaBytes: number;
  writerDelayMs: number;
  writerFailure: boolean;
  elapsedMs: number;
  throughputFramesPerSecond: number;
  latencyMs: Percentiles;
  eventLoopLagMs: Percentiles;
  memory: {
    rss: number;
    peakRss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  journalBytes: number;
  deltaJournalBytes: number;
  bridgeMetrics: ReturnType<CodexBridgeService["getStatus"]>["metrics"];
  retained: {
    sessionRecords: number;
    frameTasks: number;
    canonicalIngressCount: number;
  };
}

interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

async function runParent(options: BenchOptions): Promise<void> {
  const scenarios: Array<{
    mode: CodexBridgeJournalMode;
    connections: number;
    frames: number;
    writerDelayMs: number;
    writerFailure: boolean;
    label: string;
  }> = [];
  for (const connectionCount of options.connections) {
    for (const mode of options.modes) {
      scenarios.push({
        mode,
        connections: connectionCount,
        frames:
          mode === "legacy-blocking" ? options.legacyFrames : options.frames,
        writerDelayMs: 0,
        writerFailure: false,
        label: mode === "off" ? "no-journal" : mode,
      });
    }
    if (options.includeSlow && options.modes.includes("lifecycle")) {
      scenarios.push({
        mode: "lifecycle",
        connections: connectionCount,
        frames: options.frames,
        writerDelayMs: options.writerDelayMs || 100,
        writerFailure: false,
        label: `lifecycle-slow-${options.writerDelayMs || 100}ms`,
      });
    }
    if (options.writerFailure && options.modes.includes("lifecycle")) {
      scenarios.push({
        mode: "lifecycle",
        connections: connectionCount,
        frames: options.frames,
        writerDelayMs: 0,
        writerFailure: true,
        label: "lifecycle-writer-failure",
      });
    }
  }

  const results: BenchResult[] = [];
  for (const scenario of scenarios) {
    const result = await spawnScenario(options, scenario);
    results.push(result);
  }

  const baselines = new Map<number, BenchResult>();
  for (const result of results) {
    if (result.mode === "off" && !result.writerFailure) {
      baselines.set(result.connections, result);
    }
  }
  const report = results.map((result) => {
    const baseline = baselines.get(result.connections);
    return {
      ...result,
      relativeP95:
        baseline && baseline.latencyMs.p95 > 0
          ? round(result.latencyMs.p95 / baseline.latencyMs.p95)
          : null,
      p95AddedMs: baseline
        ? round(result.latencyMs.p95 - baseline.latencyMs.p95)
        : null,
    };
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "codex-bridge-forward",
        generatedAt: new Date().toISOString(),
        parameters: {
          frames: options.frames,
          legacyFrames: options.legacyFrames,
          connections: options.connections,
          deltaBytes: options.deltaBytes,
        },
        results: report,
      },
      null,
      2,
    )}\n`,
  );
}

async function spawnScenario(
  options: BenchOptions,
  scenario: {
    mode: CodexBridgeJournalMode;
    connections: number;
    frames: number;
    writerDelayMs: number;
    writerFailure: boolean;
    label: string;
  },
): Promise<BenchResult> {
  const args = [
    ...process.execArgv,
    SCRIPT_PATH,
    "--child",
    `--mode=${scenario.mode}`,
    `--connection-count=${scenario.connections}`,
    `--frames=${scenario.frames}`,
    `--delta-bytes=${options.deltaBytes}`,
    `--writer-delay-ms=${scenario.writerDelayMs}`,
    `--label=${scenario.label}`,
    ...(scenario.writerFailure ? ["--writer-failure"] : []),
  ];
  return await new Promise<BenchResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith(RESULT_PREFIX));
      if (code !== 0 || !line) {
        reject(
          new Error(
            `benchmark child failed code=${String(code)} stderr=${safeChildError(stderr)}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice(RESULT_PREFIX.length)) as BenchResult);
    });
  });
}

async function runChild(options: BenchOptions): Promise<BenchResult> {
  const directory = await mkdtemp(join(tmpdir(), "yep-codex-bridge-bench-"));
  const statePath = join(directory, "sessions.json");
  const upstreamServer = createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamServer });
  const upstreamSockets: WebSocket[] = [];
  upstreamWss.on("connection", (socket) => upstreamSockets.push(socket));
  await listen(upstreamServer);
  const upstreamPort = (upstreamServer.address() as AddressInfo).port;
  const bridgePort = await availablePort();
  const eventStorePath = join(directory, "codex-events.jsonl");
  const baseEventStore = new JsonlCodexEventStore({ filePath: eventStorePath });
  const eventStore = new DelayedEventStore(
    baseEventStore,
    options.writerDelayMs,
    options.writerFailure,
  );
  const serviceOptions: CodexBridgeServiceOptions = {
    enabled: true,
    host: "127.0.0.1",
    port: bridgePort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    statePath,
    journalMode: options.mode,
    ...(options.mode === "legacy-blocking"
      ? { eventStore }
      : {
          journalFlushDelayMs: options.writerDelayMs,
          ...(options.writerFailure ? { journalPath: directory } : {}),
        }),
  };
  const bridge = new CodexBridgeService(serviceOptions);
  const clients: WebSocket[] = [];
  const rssSamples: number[] = [];
  const eventLoopLagSamples: number[] = [];
  let rssTimer: ReturnType<typeof setInterval> | undefined;
  let lagTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await bridge.start();
    for (let index = 0; index < options.connectionCount; index += 1) {
      clients.push(await connect(`ws://127.0.0.1:${bridgePort}`));
    }
    await waitFor(() => upstreamSockets.length === options.connectionCount);

    if (
      (options.writerDelayMs > 0 || options.writerFailure) &&
      options.mode !== "off"
    ) {
      const primed = waitForMessageCount(clients, 1);
      for (const socket of upstreamSockets) {
        socket.send(
          JSON.stringify({
            method: "turn/started",
            params: {
              threadId: "bench-thread",
              turn: { id: "bench-turn", status: "inProgress", items: [] },
            },
          }),
        );
      }
      await primed;
      await delay(options.writerDelayMs > 0 ? 35 : 50);
    }

    let expectedLagTick = performance.now() + 5;
    lagTimer = setInterval(() => {
      const now = performance.now();
      eventLoopLagSamples.push(Math.max(0, now - expectedLagTick));
      expectedLagTick = now + 5;
    }, 5);
    lagTimer.unref?.();
    rssTimer = setInterval(
      () => rssSamples.push(process.memoryUsage().rss),
      10,
    );
    rssTimer.unref?.();

    const totalFrames = options.frames * options.connectionCount;
    const sentAt = Array.from(
      { length: options.connectionCount },
      () => new Float64Array(options.frames),
    );
    const latencies: number[] = [];
    let receivedFrames = 0;
    let resolveReceived: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    clients.forEach((client, connectionIndex) => {
      client.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as {
          method?: string;
          params?: { sequence?: number };
        };
        if (message.method !== "item/agentMessage/delta") return;
        const sequence = message.params?.sequence;
        if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return;
        const startedAt = sentAt[connectionIndex]?.[sequence as number];
        if (startedAt !== undefined) {
          latencies.push(performance.now() - startedAt);
        }
        receivedFrames += 1;
        if (receivedFrames === totalFrames) resolveReceived?.();
      });
    });

    const padding = "x".repeat(Math.max(1, options.deltaBytes));
    const startedAt = performance.now();
    for (let sequence = 0; sequence < options.frames; sequence += 1) {
      for (
        let connectionIndex = 0;
        connectionIndex < upstreamSockets.length;
        connectionIndex += 1
      ) {
        const socket = upstreamSockets[connectionIndex];
        const connectionSentAt = sentAt[connectionIndex];
        if (!socket || !connectionSentAt) continue;
        connectionSentAt[sequence] = performance.now();
        socket.send(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              threadId: `bench-thread-${connectionIndex}`,
              turnId: `bench-turn-${connectionIndex}`,
              itemId: `bench-item-${connectionIndex}`,
              sequence,
              delta: padding,
            },
          }),
        );
      }
    }
    await Promise.race([
      received,
      delay(Math.max(10_000, options.frames * options.connectionCount * 5)),
    ]);
    const elapsedMs = performance.now() - startedAt;
    const status = bridge.getStatus();
    const internals = bridge as unknown as {
      sessions: Map<string, unknown>;
      eventTasks: Set<Promise<void>>;
    };
    const memory = process.memoryUsage();
    rssSamples.push(memory.rss);
    const retained = {
      sessionRecords: internals.sessions.size,
      frameTasks: internals.eventTasks.size,
      canonicalIngressCount:
        status.metrics.codex_bridge_canonical_ingress_count,
    };

    for (const client of clients) client.close();
    await bridge.shutdown();
    if (rssTimer) clearInterval(rssTimer);
    if (lagTimer) clearInterval(lagTimer);
    const journal = await journalStats(directory, options.mode);
    const protocolVersion = await readProtocolVersion();
    return {
      label:
        readStringArg("label") ??
        (options.mode === "off" ? "no-journal" : options.mode),
      mode: options.mode,
      buildId: await readBuildId(),
      nodeVersion: process.version,
      protocolVersion,
      connections: options.connectionCount,
      framesPerConnection: options.frames,
      totalFrames,
      receivedFrames,
      deltaBytes: options.deltaBytes,
      writerDelayMs: options.writerDelayMs,
      writerFailure: options.writerFailure,
      elapsedMs: round(elapsedMs),
      throughputFramesPerSecond: round(
        receivedFrames / Math.max(0.001, elapsedMs / 1_000),
      ),
      latencyMs: percentiles(latencies),
      eventLoopLagMs: percentiles(eventLoopLagSamples),
      memory: {
        rss: memory.rss,
        peakRss: Math.max(memory.rss, ...rssSamples),
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      journalBytes: journal.totalBytes,
      deltaJournalBytes: journal.deltaBytes,
      bridgeMetrics: status.metrics,
      retained,
    };
  } finally {
    if (rssTimer) clearInterval(rssTimer);
    if (lagTimer) clearInterval(lagTimer);
    for (const client of clients) client.terminate();
    await bridge.shutdown().catch(() => undefined);
    for (const socket of upstreamWss.clients) socket.terminate();
    await closeWebSocketServer(upstreamWss);
    await closeServer(upstreamServer);
    await rm(directory, { recursive: true, force: true });
  }
}

class DelayedEventStore implements CodexEventStore {
  constructor(
    private readonly delegate: CodexEventStore,
    private readonly delayMs: number,
    private readonly fail: boolean,
  ) {}

  async append(event: CodexEventDraft): Promise<CodexEventAppendResult> {
    if (this.delayMs > 0) await delay(this.delayMs);
    if (this.fail) throw new Error("injected benchmark writer failure");
    return await this.delegate.append(event);
  }

  async appendMany(
    events: readonly CodexEventDraft[],
  ): Promise<CodexEventAppendResult[]> {
    const results: CodexEventAppendResult[] = [];
    for (const event of events) results.push(await this.append(event));
    return results;
  }

  replay(query: CodexEventReplayQuery) {
    return this.delegate.replay(query);
  }

  latestSequence(sessionId: string) {
    return this.delegate.latestSequence(sessionId);
  }

  latestEventAtMs(sessionId: string) {
    return this.delegate.latestEventAtMs(sessionId);
  }

  getStorageBytes() {
    return this.delegate.getStorageBytes?.() ?? Promise.resolve(0);
  }
}

function parseArgs(args: string[]): BenchOptions {
  const value = (name: string): string | undefined =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const integer = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(value(name) ?? "", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const modes = (value("modes") ?? "off,lifecycle,full,legacy-blocking")
    .split(",")
    .filter(isJournalMode);
  const mode = isJournalMode(value("mode")) ? value("mode") : "lifecycle";
  const connections = (value("connections") ?? "1,4")
    .split(",")
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0);
  return {
    child: args.includes("--child"),
    modes: modes.length > 0 ? modes : ["off", "lifecycle"],
    mode,
    connections: connections.length > 0 ? connections : [1],
    connectionCount: integer("connection-count", 1),
    frames: integer("frames", 10_000),
    legacyFrames: integer("legacy-frames", 2_000),
    deltaBytes: integer("delta-bytes", 1_024),
    writerDelayMs: nonNegativeInteger(value("writer-delay-ms"), 100),
    writerFailure: args.includes("--writer-failure"),
    includeSlow: !args.includes("--no-slow-writer"),
  };
}

function isJournalMode(
  value: string | undefined,
): value is CodexBridgeJournalMode {
  return (
    value === "off" ||
    value === "lifecycle" ||
    value === "full" ||
    value === "legacy-blocking"
  );
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readStringArg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return round(sorted[index] ?? 0);
}

async function journalStats(
  directory: string,
  mode: CodexBridgeJournalMode,
): Promise<{ totalBytes: number; deltaBytes: number }> {
  const prefix =
    mode === "legacy-blocking"
      ? "codex-events"
      : mode === "full"
        ? "full-diagnostic"
        : mode === "lifecycle"
          ? "lifecycle"
          : "never-match";
  const entries = await readdir(directory).catch(() => [] as string[]);
  const files = entries.filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith(".jsonl"),
  );
  let totalBytes = 0;
  let deltaBytes = 0;
  for (const entry of files) {
    const path = join(directory, entry);
    totalBytes += (await stat(path)).size;
    const contents = await readFile(path, "utf8");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { method?: string };
        if (parsed.method === "item/agentMessage/delta") {
          deltaBytes += Buffer.byteLength(line) + 1;
        }
      } catch {
        // A partial benchmark tail is counted in total bytes, not delta bytes.
      }
    }
  }
  return { totalBytes, deltaBytes };
}

async function readProtocolVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "packages/server/src/sdk/providers/codex-protocol/manifest.json",
        ),
        "utf8",
      ),
    ) as { codex?: { version?: string } };
    return manifest.codex?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function readBuildId(): Promise<string> {
  const configured = process.env.BUILD_ID ?? process.env.GIT_COMMIT;
  if (configured) return configured;
  try {
    const gitDir = join(process.cwd(), ".git");
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    const revision = head.startsWith("ref: ")
      ? (
          await readFile(join(gitDir, head.slice("ref: ".length)), "utf8")
        ).trim()
      : head;
    return `${revision.slice(0, 12)}-worktree`;
  } catch {
    return "working-tree";
  }
}

async function waitForMessageCount(
  clients: readonly WebSocket[],
  expectedPerClient: number,
): Promise<void> {
  const counts = new Array<number>(clients.length).fill(0);
  await new Promise<void>((resolve) => {
    clients.forEach((client, index) => {
      client.once("message", () => {
        counts[index] = (counts[index] ?? 0) + 1;
        if (counts.every((count) => count >= expectedPerClient)) resolve();
      });
    });
  });
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for benchmark fixture");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function safeChildError(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 500);
}

const options = parseArgs(process.argv.slice(2));
if (options.child) {
  const result = await runChild(options);
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`, () =>
    process.exit(0),
  );
} else {
  await runParent(options);
}
