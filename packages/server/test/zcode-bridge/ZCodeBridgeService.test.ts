/**
 * ZCodeBridgeService unit tests.
 *
 * Covers the plugin-facing hook ingestion path and the client-facing
 * registry/decision API with an injected config file and decision timeout —
 * no real ZCode CLI involved.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeBridgeService } from "../../src/zcode-bridge/ZCodeBridgeService.js";

describe("ZCodeBridgeService", () => {
  let tempDir: string;
  let configFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-bridge-test-"));
    configFile = join(tempDir, "yep-bridge.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(token = "test-token"): Promise<void> {
    await writeFile(
      configFile,
      JSON.stringify({ serverUrl: "http://127.0.0.1:8022/yep", token }),
    );
  }

  function makeService(
    decisionWaitMs = 5_000,
    sessionStaleMs = 10 * 60_000,
  ): ZCodeBridgeService {
    return new ZCodeBridgeService({
      configFile,
      decisionWaitMs,
      sessionStaleMs,
    });
  }

  describe("shared token", () => {
    it("is not configured when the config file is missing", async () => {
      const service = makeService();
      expect(await service.isConfigured()).toBe(false);
      expect(await service.validateToken("test-token")).toBe(false);
    });

    it("validates the installed token and rejects others", async () => {
      await writeConfig();
      const service = makeService();
      expect(await service.isConfigured()).toBe(true);
      expect(await service.validateToken("test-token")).toBe(true);
      expect(await service.validateToken("wrong-token")).toBe(false);
      expect(await service.validateToken(undefined)).toBe(false);
      expect(await service.validateToken("test-token-with-extra")).toBe(false);
    });

    it("picks up a token written after service creation", async () => {
      const service = makeService();
      expect(await service.isConfigured()).toBe(false);
      await writeConfig();
      expect(await service.validateToken("test-token")).toBe(true);
    });
  });

  describe("session registry", () => {
    it("keeps sessions registered when a turn emits Stop", async () => {
      const service = makeService();
      await service.handleHook({
        hook_event_name: "SessionStart",
        session_id: "ses-1",
        cwd: "/tmp/proj",
        permission_mode: "build",
      });
      expect(service.listSessions()).toHaveLength(1);
      expect(service.listSessions()[0]).toMatchObject({
        sessionId: "ses-1",
        cwd: "/tmp/proj",
        permissionMode: "build",
      });

      // A keepalive event refreshes state without duplicating the session.
      await service.handleHook({
        hook_event_name: "PreToolUse",
        session_id: "ses-1",
        tool_name: "Bash",
      });
      expect(service.listSessions()).toHaveLength(1);

      await service.handleHook({
        hook_event_name: "Stop",
        session_id: "ses-1",
      });
      expect(service.listSessions()).toHaveLength(1);
    });

    it("expires sessions after the configured quiet period", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
        const service = makeService(5_000, 1);
        await service.handleHook({
          hook_event_name: "SessionStart",
          session_id: "ses-stale",
        });
        expect(service.listSessions()).toHaveLength(1);

        vi.advanceTimersByTime(1);
        expect(service.listSessions()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("permission requests", () => {
    it("queues a pending input and resolves the hook with the client decision", async () => {
      const service = makeService();
      const hookPromise = service.handleHook({
        hook_event_name: "PermissionRequest",
        session_id: "ses-1",
        cwd: "/tmp/proj",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "perm-1",
      });

      // Give handleHook a tick to register the pending input.
      await new Promise((resolve) => setImmediate(resolve));
      const pending = service.listPendingInputs();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: "perm-1",
        kind: "permission",
        sessionId: "ses-1",
        cwd: "/tmp/proj",
        toolName: "Bash",
        toolInput: { command: "ls" },
      });

      expect(
        service.applyDecision("perm-1", {
          behavior: "allow",
          updatedInput: { command: "ls -la" },
        }),
      ).toBe(true);
      await expect(hookPromise).resolves.toEqual({
        decision: { behavior: "allow", updatedInput: { command: "ls -la" } },
      });
      expect(service.listPendingInputs()).toHaveLength(0);
      // A second decision on the same id is impossible.
      expect(service.applyDecision("perm-1", { behavior: "deny" })).toBe(false);
    });

    it("times out cleanly and drops the pending input", async () => {
      const service = makeService(30);
      const hookPromise = service.handleHook({
        hook_event_name: "PermissionRequest",
        session_id: "ses-1",
        tool_name: "Bash",
        tool_use_id: "perm-slow",
      });
      await expect(hookPromise).resolves.toEqual({ decision: null });
      expect(service.listPendingInputs()).toHaveLength(0);
      expect(service.applyDecision("perm-slow", { behavior: "allow" })).toBe(
        false,
      );
    });

    it("keeps a pending permission alive across a turn-level Stop hook", async () => {
      const service = makeService();
      const hookPromise = service.handleHook({
        hook_event_name: "PermissionRequest",
        session_id: "ses-1",
        tool_name: "Bash",
        tool_use_id: "perm-stop",
      });
      await new Promise((resolve) => setImmediate(resolve));
      await service.handleHook({
        hook_event_name: "Stop",
        session_id: "ses-1",
      });
      expect(service.listPendingInputs()).toHaveLength(1);
      expect(service.applyDecision("perm-stop", { behavior: "allow" })).toBe(
        true,
      );
      await expect(hookPromise).resolves.toEqual({
        decision: { behavior: "allow" },
      });
      expect(service.listPendingInputs()).toHaveLength(0);
    });

    it("generates an id when the hook omits tool_use_id", async () => {
      const service = makeService(30);
      const hookPromise = service.handleHook({
        hook_event_name: "PermissionRequest",
        session_id: "ses-1",
        tool_name: "Read",
      });
      await new Promise((resolve) => setImmediate(resolve));
      const pending = service.listPendingInputs();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBeTruthy();
      await hookPromise;
    });
  });
});
