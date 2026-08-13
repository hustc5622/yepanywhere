/**
 * ZCode bridge route tests.
 *
 * Exercises the plugin-facing POST /hook auth (shared token) and the
 * client-facing pending-input decision flow against a real
 * ZCodeBridgeService with an injected token file.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createZCodeBridgeRoutes } from "../../src/routes/zcode-bridge.js";
import { ZCodeBridgeService } from "../../src/zcode-bridge/ZCodeBridgeService.js";

const TOKEN = "route-test-token";

describe("zcode-bridge routes", () => {
  let tempDir: string;
  let routes: ReturnType<typeof createZCodeBridgeRoutes>;
  let configFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-bridge-routes-test-"));
    configFile = join(tempDir, "yep-bridge.json");
    await writeFile(
      configFile,
      JSON.stringify({ serverUrl: "http://127.0.0.1:8022/yep", token: TOKEN }),
    );
    routes = createZCodeBridgeRoutes({
      bridge: new ZCodeBridgeService({ configFile, decisionWaitMs: 5_000 }),
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function hookRequest(
    body: Record<string, unknown>,
    token?: string,
  ): Promise<Response> {
    return routes.request("/hook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-zcode-bridge-token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  describe("POST /hook auth", () => {
    it("rejects a missing or wrong token", async () => {
      expect(
        (await hookRequest({ hook_event_name: "SessionStart" })).status,
      ).toBe(401);
      expect(
        (await hookRequest({ hook_event_name: "SessionStart" }, "wrong-token"))
          .status,
      ).toBe(401);
    });

    it("returns 503 when the bridge is not installed", async () => {
      const uninstalled = createZCodeBridgeRoutes({
        bridge: new ZCodeBridgeService({
          configFile: join(tempDir, "missing.json"),
        }),
      });
      const response = await uninstalled.request("/hook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zcode-bridge-token": TOKEN,
        },
        body: JSON.stringify({ hook_event_name: "SessionStart" }),
      });
      expect(response.status).toBe(503);
    });

    it("requires hook_event_name", async () => {
      const response = await hookRequest({ session_id: "ses-1" }, TOKEN);
      expect(response.status).toBe(400);
    });
  });

  describe("session registry flow", () => {
    it("keeps the external session registered after a turn-level Stop hook", async () => {
      const start = await hookRequest(
        {
          hook_event_name: "SessionStart",
          session_id: "ses-1",
          cwd: "/tmp/proj",
          permission_mode: "build",
        },
        TOKEN,
      );
      expect(start.status).toBe(200);
      await expect(start.json()).resolves.toEqual({ ok: true });

      const list = await routes.request("/sessions");
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toMatchObject({
        installed: true,
        sessions: [{ sessionId: "ses-1", cwd: "/tmp/proj" }],
      });

      await hookRequest(
        { hook_event_name: "Stop", session_id: "ses-1" },
        TOKEN,
      );
      const after = await routes.request("/sessions");
      await expect(after.json()).resolves.toMatchObject({
        sessions: [{ sessionId: "ses-1", cwd: "/tmp/proj" }],
      });
    });
  });

  describe("permission decision flow", () => {
    it("blocks the hook until the client approves", async () => {
      const hookPromise = hookRequest(
        {
          hook_event_name: "PermissionRequest",
          session_id: "ses-1",
          cwd: "/tmp/proj",
          tool_name: "Bash",
          tool_input: { command: "rm -rf build" },
          tool_use_id: "perm-1",
        },
        TOKEN,
      );

      // Wait for the hook to register its pending input.
      let pending: { pendingInputs: Array<{ id: string }> } | null = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const listResponse = await routes.request("/pending-inputs");
        pending = (await listResponse.json()) as typeof pending;
        if ((pending?.pendingInputs.length ?? 0) > 0) break;
      }
      expect(pending?.pendingInputs).toMatchObject([
        { id: "perm-1", toolName: "Bash", cwd: "/tmp/proj" },
      ]);

      const decision = await routes.request("/pending-inputs/perm-1/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behavior: "allow" }),
      });
      expect(decision.status).toBe(200);

      const hookResponse = await hookPromise;
      expect(hookResponse.status).toBe(200);
      await expect(hookResponse.json()).resolves.toEqual({
        decision: { behavior: "allow" },
      });
    });

    it("validates the decision behavior", async () => {
      const response = await routes.request("/pending-inputs/perm-1/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behavior: "approve_always" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 404 for an unknown pending input", async () => {
      const response = await routes.request("/pending-inputs/nope/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behavior: "deny" }),
      });
      expect(response.status).toBe(404);
    });

    it("returns decision:null when nobody answers within the wait budget", async () => {
      const fastRoutes = createZCodeBridgeRoutes({
        bridge: new ZCodeBridgeService({ configFile, decisionWaitMs: 30 }),
      });
      const hookPromise = fastRoutes.request("/hook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zcode-bridge-token": TOKEN,
        },
        body: JSON.stringify({
          hook_event_name: "PermissionRequest",
          session_id: "ses-1",
          tool_name: "Bash",
          tool_use_id: "perm-timeout",
        }),
      });
      await expect(hookPromise.then((r) => r.json())).resolves.toEqual({
        decision: null,
      });
    });
  });
});
