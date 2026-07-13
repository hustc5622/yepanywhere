import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/sdk/messageQueue.js";
import { MockClaudeSDK, createMockScenario } from "../src/sdk/mock.js";
import type {
  AgentProvider,
  StartSessionOptions,
} from "../src/sdk/providers/types.js";
import { Supervisor } from "../src/supervisor/Supervisor.js";
import type { SessionSummary } from "../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../src/watcher/EventBus.js";

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

    it("passes rollbackNumTurns to provider-backed resumed sessions", async () => {
      let aborted = false;
      const startSession = vi.fn(
        async (options: {
          resumeSessionId?: string;
          rollbackNumTurns?: number;
          initialMessage?: { text: string };
        }) => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
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
      const providerSupervisor = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process = await providerSupervisor.resumeSession(
        "sess-123",
        "/tmp/test",
        { text: "q2-1" },
        undefined,
        { rollbackNumTurns: 2 },
      );

      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "sess-123",
          rollbackNumTurns: 2,
          initialMessage: expect.objectContaining({ text: "q2-1" }),
        }),
      );

      aborted = true;
      await providerSupervisor.abortProcess((process as { id: string }).id);
    });

    it("restarts an existing process before applying rollbackNumTurns", async () => {
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
              session_id: options.resumeSessionId ?? "new-session",
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

      const secondStart = starts[1];
      if (secondStart) {
        secondStart.aborted = true;
      }
      await providerSupervisor.abortProcess((process2 as { id: string }).id);
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
