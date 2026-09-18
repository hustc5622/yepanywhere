import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { CodexBridgeController } from "../../src/codex-bridge/types.js";
import type {
  RuntimeController,
  RuntimeStatus,
} from "../../src/runtime/types.js";
import type { ProcessInfo } from "../../src/supervisor/types.js";

/**
 * Captures the ownership resolver createApp installs, so the test can ask the
 * same question a bridge poll asks.
 */
function ownershipProbeBridge(): {
  bridge: CodexBridgeController;
  resolve: (sessionId: string) => Promise<boolean>;
} {
  let resolver: ((sessionId: string) => boolean | Promise<boolean>) | undefined;
  const bridge = {
    setOwnershipResolver(
      next: (sessionId: string) => boolean | Promise<boolean>,
    ) {
      resolver = next;
    },
  } as unknown as CodexBridgeController;
  return {
    bridge,
    resolve: async (sessionId: string) => {
      if (!resolver) throw new Error("createApp did not install a resolver");
      return resolver(sessionId);
    },
  };
}

/** Minimal external controller that owns exactly the sessions it is told to. */
function externalRuntime(ownedSessionIds: string[]): RuntimeController {
  const owned = new Set(ownedSessionIds);
  const processFor = (sessionId: string): ProcessInfo | null =>
    owned.has(sessionId)
      ? ({
          id: `process-${sessionId}`,
          sessionId,
          projectId: "project",
          status: "running",
        } as unknown as ProcessInfo)
      : null;

  return {
    mode: "external",
    getStatus: async () => ({ mode: "external" }) as unknown as RuntimeStatus,
    getProcessForSession: async (sessionId: string) => processFor(sessionId),
    getProcessSnapshotForSession: async () => null,
    wasEverOwned: async (sessionId: string) => owned.has(sessionId),
    listProcesses: async () =>
      [...owned].map((id) => processFor(id)).filter(Boolean) as ProcessInfo[],
    onActivityEvent: () => () => {},
    subscribeToSession: async () => ({
      events: (async function* () {})(),
      close: async () => {},
    }),
  } as unknown as RuntimeController;
}

describe("bridge ownership with an external runtime", () => {
  it("reports sessions held by the external runtime as owned", async () => {
    const sessionId = "session-held-by-external-runtime";
    const { bridge, resolve } = ownershipProbeBridge();
    const runtimeController = externalRuntime([sessionId]);

    const app = createApp({
      projectsDir: "/path/to/synthetic-projects",
      runtimeController,
      codexBridgeService: bridge,
    });

    // The runtime itself agrees it owns the session.
    await expect(
      runtimeController.getProcessForSession(sessionId),
    ).resolves.not.toBeNull();

    // A bridge poll must reach the same conclusion. Answering `false` here
    // makes the bridge emit ownership `external`/`none` for a session the
    // runtime is actively driving, which shows up as a stuck "external
    // session" banner and lets the same approval be offered twice.
    await expect(resolve(sessionId)).resolves.toBe(true);

    app.sessionInteractionService.dispose();
  });

  it("still reports unknown sessions as not owned", async () => {
    const { bridge, resolve } = ownershipProbeBridge();
    const runtimeController = externalRuntime(["owned-session"]);

    const app = createApp({
      projectsDir: "/path/to/synthetic-projects",
      runtimeController,
      codexBridgeService: bridge,
    });

    await expect(resolve("some-other-session")).resolves.toBe(false);

    app.sessionInteractionService.dispose();
  });
});
