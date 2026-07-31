import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import type { ProviderName } from "../../src/sdk/providers/types.js";
import {
  Supervisor,
  getStaleInTurnThresholdMs,
} from "../../src/supervisor/Supervisor.js";

/**
 * Regression coverage for the stale-process watchdog
 * (`Supervisor.terminateStaleProcesses`).
 *
 * Background: Kimi orchestrates work through AgentSwarm / explore subagents.
 * While a subagent runs (often several minutes), the parent ACP prompt emits
 * no SDK messages even though the underlying `kimi acp` process is very much
 * alive. Before the fix the Kimi provider did not report process liveness, so
 * the watchdog fell back to a pure time-based heuristic and killed the healthy
 * process after ~5 minutes of silence — aborting the in-flight turn (observed
 * in logs as "Terminating stale process (no liveness check) ... no messages
 * for 304s").
 *
 * The fix makes ACP-backed providers (kimi, gemini-acp) report
 * `isProcessAlive`, so a live-but-silent process short-circuits at
 * `if (alive === true) continue;` exactly like codex/claude/opencode.
 */

const FIVE_MIN = 5 * 60 * 1000;
const SIXTY_MIN = 60 * 60 * 1000;

interface StaleTestProcess {
  id: string;
  sessionId: string;
  projectId: string;
  provider: ProviderName;
  isHeld: boolean;
  state: { type: string };
  startedAt: Date;
  lastMessageTime: Date;
  isProcessAlive: boolean | undefined;
  terminate: ReturnType<typeof vi.fn>;
}

type SupervisorInternals = {
  processes: Map<string, StaleTestProcess>;
  terminateStaleProcesses: () => void;
};

describe("Supervisor stale-process watchdog", () => {
  let supervisor: Supervisor;

  beforeEach(() => {
    supervisor = new Supervisor({
      sdk: new MockClaudeSDK(),
      idleTimeoutMs: 100,
    });
  });

  afterEach(async () => {
    // Drop the injected stub processes before shutdown so it does not call
    // real Process methods (abort/etc.) on them.
    (supervisor as unknown as SupervisorInternals).processes.clear();
    await supervisor.shutdown();
  });

  function makeStubProcess(
    overrides: Partial<StaleTestProcess> & { provider: ProviderName },
  ): StaleTestProcess {
    const now = Date.now();
    const stub: StaleTestProcess = {
      id: overrides.id ?? `proc-${Math.random().toString(36).slice(2)}`,
      sessionId: overrides.sessionId ?? "session_test",
      projectId: overrides.projectId ?? "project_test",
      provider: overrides.provider,
      isHeld: overrides.isHeld ?? false,
      state: overrides.state ?? { type: "in-turn" },
      startedAt: overrides.startedAt ?? new Date(now - 10 * 60 * 1000),
      // Default: silent for well over the 5-minute default threshold.
      lastMessageTime:
        overrides.lastMessageTime ?? new Date(now - (FIVE_MIN + 30_000)),
      isProcessAlive: overrides.isProcessAlive,
      terminate: vi.fn(),
    };
    return stub;
  }

  function runStaleCheck(...procs: StaleTestProcess[]): void {
    const internals = supervisor as unknown as SupervisorInternals;
    internals.processes.clear();
    for (const p of procs) internals.processes.set(p.id, p);
    internals.terminateStaleProcesses();
  }

  describe("getStaleInTurnThresholdMs", () => {
    it("gives codex a long threshold and everyone else the default", () => {
      expect(getStaleInTurnThresholdMs("codex")).toBe(SIXTY_MIN);
      expect(getStaleInTurnThresholdMs("codex-oss")).toBe(SIXTY_MIN);
      expect(getStaleInTurnThresholdMs("kimi")).toBe(FIVE_MIN);
      expect(getStaleInTurnThresholdMs("gemini-acp")).toBe(FIVE_MIN);
      expect(getStaleInTurnThresholdMs("claude")).toBe(FIVE_MIN);
    });
  });

  describe("liveness short-circuit (the fix)", () => {
    it("does NOT terminate a live-but-silent kimi process past the threshold", () => {
      const proc = makeStubProcess({ provider: "kimi", isProcessAlive: true });
      runStaleCheck(proc);
      expect(proc.terminate).not.toHaveBeenCalled();
    });

    it("terminates a kimi process that reports no liveness (undefined)", () => {
      // Pre-fix behavior: no isProcessAlive => time-based heuristic kills it.
      const proc = makeStubProcess({
        provider: "kimi",
        isProcessAlive: undefined,
      });
      runStaleCheck(proc);
      expect(proc.terminate).toHaveBeenCalledTimes(1);
    });

    it("terminates a kimi process confirmed dead (isProcessAlive=false)", () => {
      const proc = makeStubProcess({ provider: "kimi", isProcessAlive: false });
      runStaleCheck(proc);
      expect(proc.terminate).toHaveBeenCalledTimes(1);
    });
  });

  describe("threshold gating", () => {
    it("does not terminate a kimi process still within the 5-minute window", () => {
      const proc = makeStubProcess({
        provider: "kimi",
        isProcessAlive: undefined,
        lastMessageTime: new Date(Date.now() - (FIVE_MIN - 60_000)),
      });
      runStaleCheck(proc);
      expect(proc.terminate).not.toHaveBeenCalled();
    });

    it("does not terminate a silent codex process below its 60-minute threshold", () => {
      // 6 minutes of silence: past kimi's threshold, well within codex's.
      const proc = makeStubProcess({
        provider: "codex",
        isProcessAlive: undefined,
        lastMessageTime: new Date(Date.now() - 6 * 60 * 1000),
      });
      runStaleCheck(proc);
      expect(proc.terminate).not.toHaveBeenCalled();
    });
  });

  describe("state gating", () => {
    it("ignores processes that are not in-turn", () => {
      const proc = makeStubProcess({
        provider: "kimi",
        isProcessAlive: undefined,
        state: { type: "idle" },
      });
      runStaleCheck(proc);
      expect(proc.terminate).not.toHaveBeenCalled();
    });

    it("ignores held processes", () => {
      const proc = makeStubProcess({
        provider: "kimi",
        isProcessAlive: undefined,
        isHeld: true,
      });
      runStaleCheck(proc);
      expect(proc.terminate).not.toHaveBeenCalled();
    });
  });
});
