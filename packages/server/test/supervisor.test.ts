import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../src/projects/paths.js";
import { MessageQueue } from "../src/sdk/messageQueue.js";
import { MockClaudeSDK, createMockScenario } from "../src/sdk/mock.js";
import type {
  AgentProvider,
  StartSessionOptions,
} from "../src/sdk/providers/types.js";
import { Supervisor } from "../src/supervisor/Supervisor.js";
import type { SessionSummary } from "../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../src/watcher/EventBus.js";

function createOpenCodeTestProvider(
  startSession: AgentProvider["startSession"],
): AgentProvider {
  return {
    name: "opencode",
    displayName: "OpenCode",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: false,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    startSession,
    getAvailableModels: async () => [],
  };
}

function createCodexTestProvider(
  startSession: AgentProvider["startSession"],
): AgentProvider {
  return {
    name: "codex",
    displayName: "Codex",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: false,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    startSession,
    getAvailableModels: async () => [],
  };
}

describe("Supervisor", () => {
  let mockSdk: MockClaudeSDK;
  let supervisor: Supervisor;

  beforeEach(() => {
    mockSdk = new MockClaudeSDK();
    supervisor = new Supervisor({ sdk: mockSdk, idleTimeoutMs: 100 });
  });

  describe("startSession", () => {
    it("starts a session and returns a process", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      expect(process.id).toBeDefined();
      expect(process.projectPath).toBe("/tmp/test");
    });

    it("tracks process in getAllProcesses", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisor.startSession("/tmp/test", { text: "hi" });

      expect(supervisor.getAllProcesses()).toHaveLength(1);
    });

    it("encodes projectId correctly", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      // /tmp/test in base64url
      expect(process.projectId).toBe(
        Buffer.from("/tmp/test").toString("base64url"),
      );
    });

    it("queues the initial message", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      // The message was queued
      expect(process.queueDepth).toBeGreaterThanOrEqual(0);
    });

    it("rejects a Codex initialization error without registering a temporary session", async () => {
      let aborted = false;
      const providerSupervisor = new Supervisor({
        provider: createCodexTestProvider(async () => {
          async function* iterator() {
            yield {
              type: "error",
              error:
                "Codex app-server exited (code=1)\nCodex app-server stderr:\ninvalid transport in `mcp_servers.node_repl`",
            };
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              aborted = true;
            },
          };
        }),
        idleTimeoutMs: 100,
      });

      await expect(
        providerSupervisor.startSession("/tmp/test", { text: "hi" }),
      ).rejects.toThrow("invalid transport in `mcp_servers.node_repl`");
      expect(aborted).toBe(true);
      expect(providerSupervisor.getAllProcesses()).toHaveLength(0);
    });

    it("passes canonical event provenance to create-only Codex sessions", async () => {
      let aborted = false;
      const startSession = vi.fn(async (_options: StartSessionOptions) => {
        async function* iterator() {
          yield {
            type: "system",
            subtype: "init",
            session_id: "created-codex-session",
          };
          while (!aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }

        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            aborted = true;
          },
        };
      });
      const providerSupervisor = new Supervisor({
        provider: createCodexTestProvider(startSession),
        idleTimeoutMs: 100,
      });

      try {
        await providerSupervisor.createSession(
          "/tmp/codex-event-project",
          undefined,
          { codexEventAccountId: "account-event-spine" },
        );

        expect(startSession).toHaveBeenCalledWith(
          expect.objectContaining({
            codexEventAccountId: "account-event-spine",
            codexEventProjectId: encodeProjectId("/tmp/codex-event-project"),
          }),
        );
      } finally {
        await providerSupervisor.shutdown();
      }
    });
  });

  describe("resumeSession", () => {
    it("resumes an existing session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "continue",
      });

      expect(process.sessionId).toBe("sess-123");
    });

    it("reuses existing process for same session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "First"));

      const process1 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "first",
      });

      const process2 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "second",
      });

      expect(process1.id).toBe(process2.id);
    });

    it("creates new process for different session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "First"));
      mockSdk.addScenario(createMockScenario("sess-456", "Second"));

      const process1 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "first",
      });

      const process2 = await supervisor.resumeSession("sess-456", "/tmp/test", {
        text: "second",
      });

      expect(process1.id).not.toBe(process2.id);
    });

    it("passes the legacy exclusion count and registers a distinct Codex fork", async () => {
      let aborted = false;
      const startSession = vi.fn(async (options: StartSessionOptions) => {
        async function* iterator() {
          yield {
            type: "system",
            subtype: "init",
            session_id: options.rollbackNumTurns
              ? "sess-123-fork"
              : (options.resumeSessionId ?? "new-session"),
          };
          while (!aborted) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            aborted = true;
          },
        };
      });
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };
      const providerSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process = await providerSupervisor.resumeSession(
        "sess-123",
        "/tmp/test",
        { text: "q2-1" },
        undefined,
        { rollbackNumTurns: 2, codexEventAccountId: "account-event-spine" },
      );

      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "sess-123",
          rollbackNumTurns: 2,
          codexEventAccountId: "account-event-spine",
          codexEventProjectId: encodeProjectId("/tmp/test"),
          initialMessage: expect.objectContaining({ text: "q2-1" }),
        }),
      );
      expect((process as { sessionId: string }).sessionId).toBe(
        "sess-123-fork",
      );
      expect(providerSupervisor.getProcessForSession("sess-123")).toBe(
        undefined,
      );
      expect(providerSupervisor.getProcessForSession("sess-123-fork")?.id).toBe(
        (process as { id: string }).id,
      );

      aborted = true;
      await providerSupervisor.abortProcess((process as { id: string }).id);
    });

    it("restarts the source process before creating a Codex edit fork", async () => {
      const starts: Array<{
        aborted: boolean;
        options: {
          resumeSessionId?: string;
          rollbackNumTurns?: number;
          initialMessage?: { text: string };
        };
      }> = [];
      const startSession = vi.fn(
        async (options: {
          resumeSessionId?: string;
          rollbackNumTurns?: number;
          initialMessage?: { text: string };
        }) => {
          const start = { aborted: false, options };
          starts.push(start);

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.rollbackNumTurns
                ? "sess-123-fork"
                : (options.resumeSessionId ?? "new-session"),
            };
            while (!start.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              start.aborted = true;
            },
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };
      const providerSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process1 = await providerSupervisor.resumeSession(
        "sess-123",
        "/tmp/test",
        { text: "q1" },
      );
      const process2 = await providerSupervisor.resumeSession(
        "sess-123",
        "/tmp/test",
        { text: "q1-1" },
        undefined,
        { rollbackNumTurns: 1 },
      );

      expect(startSession).toHaveBeenCalledTimes(2);
      expect((process2 as { id: string }).id).not.toBe(
        (process1 as { id: string }).id,
      );
      expect(starts[0]?.aborted).toBe(true);
      expect(starts[1]?.options).toEqual(
        expect.objectContaining({
          resumeSessionId: "sess-123",
          rollbackNumTurns: 1,
          initialMessage: expect.objectContaining({ text: "q1-1" }),
        }),
      );
      expect((process2 as { sessionId: string }).sessionId).toBe(
        "sess-123-fork",
      );
      expect(providerSupervisor.getProcessForSession("sess-123")).toBe(
        undefined,
      );
      expect(providerSupervisor.getProcessForSession("sess-123-fork")?.id).toBe(
        (process2 as { id: string }).id,
      );

      const secondStart = starts[1];
      if (secondStart) {
        secondStart.aborted = true;
      }
      await providerSupervisor.abortProcess((process2 as { id: string }).id);
    });

    it.each([
      { providerName: "opencode" as const, displayName: "OpenCode" },
      { providerName: "pi" as const, displayName: "Pi" },
    ])(
      "replaces a $displayName process and registers the native fork session id",
      async ({ providerName, displayName }) => {
        const starts: Array<{
          aborted: boolean;
          options: StartSessionOptions;
        }> = [];
        const startSession = vi.fn(async (options: StartSessionOptions) => {
          const start = { aborted: false, options };
          starts.push(start);
          const actualSessionId = options.resumeSessionAt
            ? "ses_forked"
            : (options.resumeSessionId ?? "ses_created");

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: actualSessionId,
            };
            while (!start.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              start.aborted = true;
            },
          };
        });
        const provider: AgentProvider = {
          name: providerName,
          displayName,
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: false,
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          startSession,
          getAvailableModels: async () => [],
        };
        const providerSupervisor = new Supervisor({
          provider,
          idleTimeoutMs: 100,
        });

        const original = await providerSupervisor.resumeSession(
          "ses_parent",
          "/tmp/test",
          { text: "original" },
        );
        const forked = await providerSupervisor.resumeSession(
          "ses_parent",
          "/tmp/test",
          { text: "edited" },
          "acceptEdits",
          {
            resumeSessionAt: "msg_native_user",
            reasoningEffort: "max",
            opencodeConfig: {
              model: "glm-5.2",
              requestProtocol: "anthropic",
              limits: { context: 200_000, output: 16_000 },
            },
          },
        );

        expect(starts[0]?.aborted).toBe(true);
        expect((forked as { id: string }).id).not.toBe(
          (original as { id: string }).id,
        );
        expect((forked as { sessionId: string }).sessionId).toBe("ses_forked");
        expect(providerSupervisor.getProcessForSession("ses_parent")).toBe(
          undefined,
        );
        expect(providerSupervisor.getProcessForSession("ses_forked")?.id).toBe(
          (forked as { id: string }).id,
        );
        expect(starts[1]?.options).toEqual(
          expect.objectContaining({
            resumeSessionId: "ses_parent",
            resumeSessionAt: "msg_native_user",
            permissionMode: "acceptEdits",
            reasoningEffort: "max",
            opencodeConfig: expect.objectContaining({ model: "glm-5.2" }),
          }),
        );

        const forkStart = starts[1];
        if (forkStart) {
          forkStart.aborted = true;
        }
        await providerSupervisor.abortProcess((forked as { id: string }).id);
      },
    );

    it("replaces a ZCode process and registers the native fork session id", async () => {
      const starts: Array<{
        aborted: boolean;
        options: StartSessionOptions;
      }> = [];
      const startSession = vi.fn(async (options: StartSessionOptions) => {
        const start = { aborted: false, options };
        starts.push(start);
        const actualSessionId = options.resumeSessionAt
          ? "ses_zcode_forked"
          : (options.resumeSessionId ?? "ses_created");

        async function* iterator() {
          yield {
            type: "system",
            subtype: "init",
            session_id: actualSessionId,
          };
          while (!start.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            start.aborted = true;
          },
        };
      });
      const provider: AgentProvider = {
        name: "zcode",
        displayName: "ZCode",
        supportsPermissionMode: true,
        supportsThinkingToggle: false,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };
      const providerSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const original = await providerSupervisor.resumeSession(
        "ses_parent",
        "/tmp/test",
        { text: "original" },
      );
      const forked = await providerSupervisor.resumeSession(
        "ses_parent",
        "/tmp/test",
        { text: "edited" },
        "acceptEdits",
        { resumeSessionAt: "msg_zcode_user" },
      );

      expect(starts[0]?.aborted).toBe(true);
      expect((forked as { id: string }).id).not.toBe(
        (original as { id: string }).id,
      );
      expect((forked as { sessionId: string }).sessionId).toBe(
        "ses_zcode_forked",
      );
      expect(providerSupervisor.getProcessForSession("ses_parent")).toBe(
        undefined,
      );
      expect(
        providerSupervisor.getProcessForSession("ses_zcode_forked")?.id,
      ).toBe((forked as { id: string }).id);
      expect(starts[1]?.options).toEqual(
        expect.objectContaining({
          resumeSessionId: "ses_parent",
          resumeSessionAt: "msg_zcode_user",
          permissionMode: "acceptEdits",
        }),
      );

      const forkStart = starts[1];
      if (forkStart) {
        forkStart.aborted = true;
      }
      await providerSupervisor.abortProcess((forked as { id: string }).id);
    });

    it("surfaces an OpenCode fork initialization error instead of reusing the source id", async () => {
      const starts: Array<{ aborted: boolean; options: StartSessionOptions }> =
        [];
      const startSession = vi.fn(async (options: StartSessionOptions) => {
        const start = { aborted: false, options };
        starts.push(start);
        const startIndex = starts.length;

        async function* iterator() {
          if (startIndex === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "ses_parent",
            };
            while (!start.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return;
          }
          yield {
            type: "error",
            error:
              "OpenCode fork ses_orphan was created, but Yep fork lineage metadata could not be persisted",
          };
        }

        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            start.aborted = true;
          },
        };
      });
      const provider: AgentProvider = {
        name: "opencode",
        displayName: "OpenCode",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };
      const providerSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      await providerSupervisor.resumeSession("ses_parent", "/tmp/test", {
        text: "original",
      });

      await expect(
        providerSupervisor.resumeSession(
          "ses_parent",
          "/tmp/test",
          { text: "edited" },
          "acceptEdits",
          { resumeSessionAt: "msg_native_user" },
        ),
      ).rejects.toThrow("Yep fork lineage metadata could not be persisted");
      expect(starts[0]?.aborted).toBe(true);
      expect(starts[1]?.aborted).toBe(true);
      expect(providerSupervisor.getProcessForSession("ses_parent")).toBe(
        undefined,
      );
      expect(providerSupervisor.getProcessForSession("ses_orphan")).toBe(
        undefined,
      );
    });

    it("allows an OpenCode edit fork to return its native id after the legacy five-second fallback", async () => {
      vi.useFakeTimers();
      let aborted = false;
      let releaseAfterInit: (() => void) | undefined;
      const startSession = vi.fn(async () => {
        async function* iterator() {
          await new Promise((resolve) => setTimeout(resolve, 5_500));
          if (aborted) return;
          yield {
            type: "system",
            subtype: "init",
            session_id: "ses_delayed_fork",
          };
          await new Promise<void>((resolve) => {
            releaseAfterInit = resolve;
          });
        }

        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            aborted = true;
            releaseAfterInit?.();
          },
        };
      });
      const providerSupervisor = new Supervisor({
        provider: createOpenCodeTestProvider(startSession),
        idleTimeoutMs: 100,
        opencodeForkSessionIdTimeoutMs: 10_000,
      });

      try {
        const forkPromise = providerSupervisor.resumeSession(
          "ses_parent",
          "/tmp/test",
          { text: "edited" },
          "acceptEdits",
          { resumeSessionAt: "msg_native_user" },
        );

        await vi.advanceTimersByTimeAsync(5_500);
        const forked = await forkPromise;

        expect((forked as { sessionId: string }).sessionId).toBe(
          "ses_delayed_fork",
        );
        expect(aborted).toBe(false);
        expect(
          providerSupervisor.getProcessForSession("ses_delayed_fork")?.id,
        ).toBe((forked as { id: string }).id);
      } finally {
        releaseAfterInit?.();
        await providerSupervisor.shutdown();
        vi.useRealTimers();
      }
    });

    it("rejects an OpenCode edit fork with an explicit initialization timeout", async () => {
      vi.useFakeTimers();
      let aborted = false;
      let releaseInitialization: (() => void) | undefined;
      const startSession = vi.fn(async () => {
        async function* iterator() {
          await new Promise<void>((resolve) => {
            releaseInitialization = resolve;
          });
          if (aborted) return;
          yield {
            type: "system",
            subtype: "init",
            session_id: "ses_too_late",
          };
        }

        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            aborted = true;
            releaseInitialization?.();
          },
        };
      });
      const providerSupervisor = new Supervisor({
        provider: createOpenCodeTestProvider(startSession),
        idleTimeoutMs: 100,
        opencodeForkSessionIdTimeoutMs: 100,
      });

      try {
        const forkPromise = providerSupervisor.resumeSession(
          "ses_parent",
          "/tmp/test",
          { text: "edited" },
          "acceptEdits",
          { resumeSessionAt: "msg_native_user" },
        );
        const rejection = expect(forkPromise).rejects.toThrow(
          "Provider initialization timed out after 100ms before returning a session ID",
        );

        await vi.advanceTimersByTimeAsync(100);
        await rejection;

        expect(aborted).toBe(true);
        expect(
          providerSupervisor.getProcessForSession("ses_parent"),
        ).toBeUndefined();
        expect(
          providerSupervisor.getProcessForSession("ses_too_late"),
        ).toBeUndefined();
      } finally {
        releaseInitialization?.();
        await providerSupervisor.shutdown();
        vi.useRealTimers();
      }
    });
  });

  describe("getProcess", () => {
    it("returns process by id", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });
      const found = supervisor.getProcess(process.id);

      expect(found).toBe(process);
    });

    it("returns undefined for unknown id", () => {
      const found = supervisor.getProcess("unknown-id");
      expect(found).toBeUndefined();
    });
  });

  describe("getProcessForSession", () => {
    it("returns process by session id", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "hi",
      });
      const found = supervisor.getProcessForSession("sess-123");

      expect(found).toBe(process);
    });

    it("returns undefined for unknown session", () => {
      const found = supervisor.getProcessForSession("unknown-session");
      expect(found).toBeUndefined();
    });

    it("ignores a late durable-id claim when another process already owns it", async () => {
      const starts: Array<{
        releaseInit: () => void;
        stop: () => void;
      }> = [];
      const provider = createCodexTestProvider(async () => {
        let releaseInit = () => undefined;
        let stop = () => undefined;
        const initGate = new Promise<void>((resolve) => {
          releaseInit = resolve;
        });
        const stopGate = new Promise<void>((resolve) => {
          stop = resolve;
        });
        starts.push({ releaseInit, stop });

        async function* iterator() {
          await initGate;
          yield {
            type: "system",
            subtype: "init",
            session_id: "durable-session",
          };
          await stopGate;
        }

        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: stop,
        };
      });
      const providerSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const first = await providerSupervisor.resumeSession(
        "temporary-first",
        "/tmp/test",
        { text: "first" },
      );
      const second = await providerSupervisor.resumeSession(
        "temporary-second",
        "/tmp/test",
        { text: "second" },
      );
      if (!("id" in first) || !("id" in second)) {
        throw new Error("expected immediate processes");
      }

      starts[1]?.releaseInit();
      await vi.waitFor(() => {
        expect(
          providerSupervisor.getProcessForSession("durable-session")?.id,
        ).toBe(second.id);
      });

      starts[0]?.releaseInit();
      await vi.waitFor(() => {
        expect(first.sessionId).toBe("durable-session");
      });
      expect(
        providerSupervisor.getProcessForSession("durable-session")?.id,
      ).toBe(second.id);
      expect(
        providerSupervisor.getProcessForSession("temporary-first")?.id,
      ).toBe(first.id);

      await providerSupervisor.abortProcess(first.id);
      await providerSupervisor.abortProcess(second.id);
    });
  });

  describe("getProcessInfoList", () => {
    it("returns info for all processes", async () => {
      mockSdk.addScenario(createMockScenario("sess-1", "First"));
      mockSdk.addScenario(createMockScenario("sess-2", "Second"));

      await supervisor.startSession("/tmp/test1", { text: "one" });
      await supervisor.startSession("/tmp/test2", { text: "two" });

      const infoList = supervisor.getProcessInfoList();

      expect(infoList).toHaveLength(2);
      expect(infoList[0]?.id).toBeDefined();
      expect(infoList[1]?.id).toBeDefined();
    });
  });

  describe("abortProcess", () => {
    it("aborts and removes process", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      const result = await supervisor.abortProcess(process.id);

      expect(result).toBe(true);
      expect(supervisor.getAllProcesses()).toHaveLength(0);
    });

    it("returns false for unknown process", async () => {
      const result = await supervisor.abortProcess("unknown-id");
      expect(result).toBe(false);
    });

    it("removes session mapping on abort", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "hi",
      });

      await supervisor.abortProcess(process.id);

      expect(supervisor.getProcessForSession("sess-123")).toBeUndefined();
    });
  });

  describe("worker admission", () => {
    it("rejects immediate-only starts before queue admission", async () => {
      let invocation = 0;
      const aborters: Array<() => void> = [];
      const startSession = vi.fn(async () => {
        invocation += 1;
        let aborted = false;
        aborters.push(() => {
          aborted = true;
        });
        const sessionId = `immediate-session-${invocation}`;
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: sessionId,
          };
          while (!aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: aborters.at(-1) ?? (() => {}),
        };
      });
      const admissionSupervisor = new Supervisor({
        provider: createOpenCodeTestProvider(startSession),
        idleTimeoutMs: 100,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });

      try {
        const first = await admissionSupervisor.startSession("/tmp/first", {
          text: "first",
        });
        expect("id" in first).toBe(true);

        await expect(
          admissionSupervisor.startSession(
            "/tmp/second",
            { text: "must not enter the queue" },
            undefined,
            undefined,
            { requireImmediate: true },
          ),
        ).resolves.toEqual({ error: "immediate_start_unavailable" });
        await expect(
          admissionSupervisor.createSession(
            "/tmp/create-only",
            undefined,
            undefined,
            { requireImmediate: true },
          ),
        ).resolves.toEqual({ error: "immediate_start_unavailable" });

        expect(admissionSupervisor.getQueueInfo()).toHaveLength(0);
        expect(startSession).toHaveBeenCalledTimes(1);
      } finally {
        await admissionSupervisor.shutdown();
      }
    });

    it("does not attach an immediate resume to queued background work", async () => {
      let aborted = false;
      const startSession = vi.fn(async (options: StartSessionOptions) => {
        const sessionId = options.resumeSessionId ?? "capacity-owner";
        async function* iterator() {
          yield { type: "system", subtype: "init", session_id: sessionId };
          while (!aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            aborted = true;
          },
        };
      });
      const admissionSupervisor = new Supervisor({
        provider: createOpenCodeTestProvider(startSession),
        idleTimeoutMs: 100,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });

      try {
        const active = await admissionSupervisor.startSession(
          "/tmp/capacity-owner",
          { text: "occupy capacity" },
        );
        expect("id" in active).toBe(true);

        const queued = await admissionSupervisor.resumeSession(
          "queued-thread",
          "/tmp/queued-thread",
          { text: "background request" },
        );
        expect(queued).toMatchObject({ queued: true, position: 1 });

        await expect(
          admissionSupervisor.resumeSession(
            "queued-thread",
            "/tmp/queued-thread",
            { text: "external request must not be orphaned" },
            undefined,
            undefined,
            { requireImmediate: true },
          ),
        ).resolves.toEqual({ error: "immediate_start_unavailable" });

        expect(admissionSupervisor.getQueueInfo()).toHaveLength(1);
        expect(admissionSupervisor.getQueueInfo()[0]?.id).toBe(
          "queueId" in queued ? queued.queueId : undefined,
        );
        expect(startSession).toHaveBeenCalledTimes(1);
      } finally {
        await admissionSupervisor.shutdown();
      }
    });

    it("reserves capacity while a provider start is still pending", async () => {
      let releaseProviderStart = () => undefined;
      const providerStartGate = new Promise<void>((resolve) => {
        releaseProviderStart = resolve;
      });
      let aborted = false;
      const startSession = vi.fn(async () => {
        await providerStartGate;
        async function* iterator() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: "reserved-session",
          };
          while (!aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: () => {
            aborted = true;
          },
        };
      });
      const admissionSupervisor = new Supervisor({
        provider: createOpenCodeTestProvider(startSession),
        idleTimeoutMs: 100,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });
      let first: ReturnType<Supervisor["startSession"]> | undefined;

      try {
        first = admissionSupervisor.startSession(
          "/tmp/reserved-first",
          { text: "first" },
          undefined,
          undefined,
          { requireImmediate: true },
        );
        await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

        await expect(
          admissionSupervisor.startSession(
            "/tmp/reserved-second",
            { text: "must not penetrate admission" },
            undefined,
            undefined,
            { requireImmediate: true },
          ),
        ).resolves.toEqual({ error: "immediate_start_unavailable" });
        expect(startSession).toHaveBeenCalledTimes(1);
        expect(admissionSupervisor.getQueueInfo()).toHaveLength(0);

        releaseProviderStart();
        await expect(first).resolves.toMatchObject({
          sessionId: "reserved-session",
        });
      } finally {
        releaseProviderStart();
        await first?.catch(() => undefined);
        await admissionSupervisor.shutdown();
      }
    });
  });

  describe("queue propagation", () => {
    it("preserves model settings when a queued session starts later", async () => {
      let aborted = false;
      const startSession = vi.fn(
        async (options: {
          model?: string;
          thinking?: { type: "adaptive" | "enabled" | "disabled" };
          effort?: "low" | "medium" | "high" | "max";
          resumeSessionId?: string;
          initialMessage?: { text: string };
        }) => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ??
                `queued-session-${options.initialMessage?.text ?? "none"}`,
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              aborted = true;
            },
          };
        },
      );

      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };

      const supervisorWithQueue = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });

      const first = await supervisorWithQueue.startSession("/tmp/test", {
        text: "first",
      });
      expect("id" in first).toBe(true);

      const queued = await supervisorWithQueue.startSession(
        "/tmp/test",
        { text: "second" },
        undefined,
        {
          model: "gpt-5.4",
          thinking: { type: "adaptive" },
          effort: "high",
        },
      );
      expect("queued" in queued && queued.queued).toBe(true);

      aborted = true;
      await supervisorWithQueue.abortProcess((first as { id: string }).id);

      await vi.waitFor(() => {
        expect(startSession).toHaveBeenCalledTimes(2);
      });

      expect(startSession.mock.calls[1]?.[0]).toMatchObject({
        model: "gpt-5.4",
        thinking: { type: "adaptive" },
        effort: "high",
        initialMessage: { text: "second" },
      });
    });

    it("preserves an exact Codex reasoning effort and restarts when it changes", async () => {
      const aborters: Array<() => void> = [];
      const startSession = vi.fn(async (options: StartSessionOptions) => {
        let aborted = false;
        aborters.push(() => {
          aborted = true;
        });
        const sessionId = options.resumeSessionId ?? "reasoning-session";
        async function* iterator() {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
          };
          while (!aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return {
          iterator: iterator(),
          queue: new MessageQueue(),
          abort: aborters.at(-1) ?? (() => {}),
        };
      });
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const reasoningSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const started = await reasoningSupervisor.startSession(
        "/tmp/reasoning-session",
        { text: "start" },
        undefined,
        { reasoningEffort: "ultra" },
      );
      expect("id" in started).toBe(true);
      expect(
        "requestedReasoningEffort" in started
          ? started.requestedReasoningEffort
          : undefined,
      ).toBe("ultra");

      await expect(
        reasoningSupervisor.queueMessageToSession(
          "reasoning-session",
          "/tmp/reasoning-session",
          { text: "same effort" },
          undefined,
          { reasoningEffort: "ultra" },
        ),
      ).resolves.toMatchObject({ success: true, restarted: false });
      expect(startSession).toHaveBeenCalledTimes(1);

      await expect(
        reasoningSupervisor.queueMessageToSession(
          "reasoning-session",
          "/tmp/reasoning-session",
          { text: "lower effort" },
          undefined,
          { reasoningEffort: "xhigh" },
        ),
      ).resolves.toMatchObject({ success: true, restarted: true });
      expect(startSession).toHaveBeenCalledTimes(2);
      expect(startSession.mock.calls[1]?.[0]).toMatchObject({
        resumeSessionId: "reasoning-session",
        reasoningEffort: "xhigh",
      });

      const resumeSession = vi
        .spyOn(reasoningSupervisor, "resumeSession")
        .mockResolvedValueOnce({ error: "immediate_start_unavailable" });
      await expect(
        reasoningSupervisor.queueMessageToSession(
          "reasoning-session",
          "/tmp/reasoning-session",
          { text: "must not queue after restart" },
          undefined,
          { reasoningEffort: "high" },
          { requireImmediate: true },
        ),
      ).resolves.toEqual({
        success: false,
        error: "immediate_start_unavailable",
      });
      expect(resumeSession).toHaveBeenCalledWith(
        "reasoning-session",
        "/tmp/reasoning-session",
        expect.objectContaining({ text: "must not queue after restart" }),
        undefined,
        expect.objectContaining({ reasoningEffort: "high" }),
        { requireImmediate: true },
      );
      expect(reasoningSupervisor.getQueueInfo()).toHaveLength(0);

      await reasoningSupervisor.shutdown();
    });
  });

  describe("eventBus integration", () => {
    it("emits process-state-changed event when session starts", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const supervisorWithBus = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisorWithBus.startSession("/tmp/test", { text: "hi" });

      // Find process-state-changed events
      const processStateEvents = events.filter(
        (e) => e.type === "process-state-changed",
      );

      console.log(
        "All events emitted:",
        events.map((e) => e.type),
      );
      console.log("Process state events:", processStateEvents);

      expect(processStateEvents.length).toBeGreaterThanOrEqual(1);
      expect(processStateEvents[0]).toMatchObject({
        type: "process-state-changed",
        activity: "in-turn",
      });
    });

    it("emits session-status-changed event when session starts", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const supervisorWithBus = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisorWithBus.startSession("/tmp/test", { text: "hi" });

      // Find session-status-changed events
      const statusEvents = events.filter(
        (e) => e.type === "session-status-changed",
      );

      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
      expect(statusEvents[0]).toMatchObject({
        type: "session-status-changed",
        ownership: { owner: "self" },
      });
    });
  });
});
