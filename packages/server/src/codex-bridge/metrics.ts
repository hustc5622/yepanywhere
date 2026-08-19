import type { CodexBridgeJournalStats } from "./CodexBridgeJournal.js";

const MAX_LATENCY_SAMPLES = 512;
const EVENT_LOOP_SAMPLE_MS = 1_000;

export interface CodexBridgeLatencyMetric {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface CodexBridgeMetricsSnapshot {
  codex_bridge_frame_parse_ms: CodexBridgeLatencyMetric;
  codex_bridge_profile_resolution_ms: CodexBridgeLatencyMetric;
  codex_bridge_state_projection_ms: CodexBridgeLatencyMetric;
  codex_bridge_forward_ms: CodexBridgeLatencyMetric;
  codex_bridge_journal_enqueue_ms: CodexBridgeLatencyMetric;
  codex_bridge_journal_flush_ms: CodexBridgeLatencyMetric;
  codex_bridge_event_loop_lag_ms: CodexBridgeLatencyMetric;
  codex_bridge_journal_queue_bytes: number;
  codex_bridge_journal_queue_peak_bytes: number;
  codex_bridge_journal_dropped_events_total: number;
  codex_bridge_journal_failures_total: number;
  codex_bridge_journal_bytes: number;
  codex_bridge_frames_total: number;
  codex_bridge_delta_frames_total: number;
  codex_bridge_diagnostic_frames_total: number;
  codex_bridge_canonical_ingress_count: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export function emptyCodexBridgeMetricsSnapshot(): CodexBridgeMetricsSnapshot {
  const latency = (): CodexBridgeLatencyMetric => ({
    samples: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
  });
  return {
    codex_bridge_frame_parse_ms: latency(),
    codex_bridge_profile_resolution_ms: latency(),
    codex_bridge_state_projection_ms: latency(),
    codex_bridge_forward_ms: latency(),
    codex_bridge_journal_enqueue_ms: latency(),
    codex_bridge_journal_flush_ms: latency(),
    codex_bridge_event_loop_lag_ms: latency(),
    codex_bridge_journal_queue_bytes: 0,
    codex_bridge_journal_queue_peak_bytes: 0,
    codex_bridge_journal_dropped_events_total: 0,
    codex_bridge_journal_failures_total: 0,
    codex_bridge_journal_bytes: 0,
    codex_bridge_frames_total: 0,
    codex_bridge_delta_frames_total: 0,
    codex_bridge_diagnostic_frames_total: 0,
    codex_bridge_canonical_ingress_count: 0,
    rss: 0,
    heapUsed: 0,
    heapTotal: 0,
    external: 0,
    arrayBuffers: 0,
  };
}

class BoundedLatencySamples {
  private readonly values: number[] = [];
  private cursor = 0;
  private totalSamples = 0;

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const rounded = Math.round(value * 1_000) / 1_000;
    if (this.values.length < MAX_LATENCY_SAMPLES) {
      this.values.push(rounded);
    } else {
      this.values[this.cursor] = rounded;
      this.cursor = (this.cursor + 1) % MAX_LATENCY_SAMPLES;
    }
    this.totalSamples += 1;
  }

  snapshot(): CodexBridgeLatencyMetric {
    if (this.values.length === 0) {
      return { samples: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    return {
      samples: this.totalSamples,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? 0,
    };
  }
}

/** Low-frequency, bounded and content-free bridge telemetry. */
export class CodexBridgeMetrics {
  private readonly parse = new BoundedLatencySamples();
  private readonly profile = new BoundedLatencySamples();
  private readonly projection = new BoundedLatencySamples();
  private readonly forward = new BoundedLatencySamples();
  private readonly enqueue = new BoundedLatencySamples();
  private readonly flush = new BoundedLatencySamples();
  private readonly eventLoop = new BoundedLatencySamples();
  private frames = 0;
  private deltaFrames = 0;
  private diagnosticFrames = 0;
  private expectedEventLoopTick = performance.now() + EVENT_LOOP_SAMPLE_MS;
  private readonly eventLoopTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.eventLoopTimer = setInterval(() => {
      const now = performance.now();
      this.eventLoop.observe(Math.max(0, now - this.expectedEventLoopTick));
      this.expectedEventLoopTick = now + EVENT_LOOP_SAMPLE_MS;
    }, EVENT_LOOP_SAMPLE_MS);
    this.eventLoopTimer.unref?.();
  }

  observeParse(durationMs: number): void {
    this.frames += 1;
    this.parse.observe(durationMs);
  }

  observeDeltaFrame(): void {
    this.deltaFrames += 1;
  }

  observeDiagnosticFrame(): void {
    this.diagnosticFrames += 1;
  }

  observeProfile(durationMs: number): void {
    this.profile.observe(durationMs);
  }

  observeProjection(durationMs: number): void {
    this.projection.observe(durationMs);
  }

  observeForward(durationMs: number): void {
    this.forward.observe(durationMs);
  }

  observeEnqueue(durationMs: number): void {
    this.enqueue.observe(durationMs);
  }

  observeFlush(durationMs: number): void {
    this.flush.observe(durationMs);
  }

  snapshot(
    journal: CodexBridgeJournalStats | null,
    canonicalIngressCount: number,
  ): CodexBridgeMetricsSnapshot {
    const memory = process.memoryUsage();
    return {
      codex_bridge_frame_parse_ms: this.parse.snapshot(),
      codex_bridge_profile_resolution_ms: this.profile.snapshot(),
      codex_bridge_state_projection_ms: this.projection.snapshot(),
      codex_bridge_forward_ms: this.forward.snapshot(),
      codex_bridge_journal_enqueue_ms: this.enqueue.snapshot(),
      codex_bridge_journal_flush_ms: this.flush.snapshot(),
      codex_bridge_event_loop_lag_ms: this.eventLoop.snapshot(),
      codex_bridge_journal_queue_bytes: journal?.queueBytes ?? 0,
      codex_bridge_journal_queue_peak_bytes: journal?.peakQueueBytes ?? 0,
      codex_bridge_journal_dropped_events_total: journal?.droppedRecords ?? 0,
      codex_bridge_journal_failures_total: journal?.flushFailures ?? 0,
      codex_bridge_journal_bytes: journal?.journalBytes ?? 0,
      codex_bridge_frames_total: this.frames,
      codex_bridge_delta_frames_total: this.deltaFrames,
      codex_bridge_diagnostic_frames_total: this.diagnosticFrames,
      codex_bridge_canonical_ingress_count: canonicalIngressCount,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    };
  }

  close(): void {
    clearInterval(this.eventLoopTimer);
  }
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}
