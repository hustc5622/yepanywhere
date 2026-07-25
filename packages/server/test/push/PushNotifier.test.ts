import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationService } from "../../src/notifications/NotificationService.js";
import { PushNotifier } from "../../src/push/PushNotifier.js";
import type { PushService } from "../../src/push/PushService.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { InputRequest, ProcessState } from "../../src/supervisor/types.js";
import type {
  BusEvent,
  EventBus,
  ProcessStateEvent,
} from "../../src/watcher/EventBus.js";

describe("PushNotifier", () => {
  let mockEventBus: EventBus;
  let mockPushService: PushService;
  let mockNotificationService: NotificationService;
  let mockSupervisor: Supervisor;
  let eventHandler: ((event: BusEvent) => void) | null = null;
  let unsubscribeCalled = false;

  const testProjectId = Buffer.from("/home/user/test-project").toString(
    "base64url",
  ) as UrlProjectId;

  beforeEach(() => {
    eventHandler = null;
    unsubscribeCalled = false;

    // Mock EventBus
    mockEventBus = {
      subscribe: vi.fn((handler) => {
        eventHandler = handler;
        return () => {
          unsubscribeCalled = true;
        };
      }),
      emit: vi.fn(),
    } as unknown as EventBus;

    // Mock PushService
    mockPushService = {
      getSubscriptionCount: vi.fn(() => 1),
      sendToAll: vi.fn(() =>
        Promise.resolve([{ browserProfileId: "profile-1", success: true }]),
      ),
      isNotificationTypeEnabled: vi.fn(() => true),
    } as unknown as PushService;

    mockNotificationService = {
      markSessionNeedsReview: vi.fn(() => Promise.resolve()),
      clearSessionNeedsReview: vi.fn(() => Promise.resolve()),
    } as unknown as NotificationService;

    // Mock Supervisor
    mockSupervisor = {
      getProcessForSession: vi.fn(),
    } as unknown as Supervisor;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    it("should subscribe to EventBus on construction", () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      expect(mockEventBus.subscribe).toHaveBeenCalled();
      expect(eventHandler).not.toBeNull();
    });

    it("should unsubscribe on dispose", () => {
      const notifier = new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      notifier.dispose();

      expect(unsubscribeCalled).toBe(true);
    });
  });

  describe("handling process state changes", () => {
    it("reads pending input from an external runtime snapshot", async () => {
      const request: InputRequest = {
        id: "req-external",
        sessionId: "session-external",
        type: "tool-approval",
        prompt: "Allow Edit?",
        toolName: "Edit",
        toolInput: { file_path: "/home/user/test-project/src/index.ts" },
        timestamp: new Date().toISOString(),
      };
      const runtimeController = {
        getProcessSnapshotForSession: vi.fn(async () => ({
          id: "proc-external",
          state: "waiting-input",
          pendingInputRequest: request,
          messageHistory: [],
        })),
      } as unknown as Pick<RuntimeController, "getProcessSnapshotForSession">;

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        runtimeController,
      });

      eventHandler?.({
        type: "process-state-changed",
        sessionId: "session-external",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "pending-input",
            sessionId: "session-external",
            requestId: "req-external",
          }),
          expect.any(Object),
        );
      });
    });

    it("should send push notification when entering waiting-input state", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            toolInput: { file_path: "/home/user/test-project/src/index.ts" },
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      // Emit a waiting-input event
      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Wait for async processing
      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.type).toBe("pending-input");
      expect(payload.sessionId).toBe("session-1");
      expect(payload.projectId).toBe(testProjectId);
      expect(payload.projectName).toBe("test-project");
      expect(payload.inputType).toBe("tool-approval");
      expect(payload.summary).toBe("Edit: index.ts");
      expect(payload.requestId).toBe("req-1");
    });

    it("should not send push when activity is in-turn", async () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "in-turn",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should not send push when no subscriptions exist", async () => {
      vi.mocked(mockPushService.getSubscriptionCount).mockReturnValue(0);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should not send push when process not found", async () => {
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(undefined);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("falls back to bridge pending input when no process owns the session", async () => {
      const request: InputRequest = {
        id: "req-bridge",
        sessionId: "thread-bridge",
        type: "tool-approval",
        prompt: "Allow bash?",
        toolName: "Bash",
        toolInput: { command: "ls" },
        timestamp: new Date().toISOString(),
        source: "codex-bridge",
      };
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(undefined);
      const bridgeController = {
        getPendingInputRequest: vi.fn(async (sessionId: string) =>
          sessionId === "thread-bridge" ? request : null,
        ),
      };

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
        bridgeControllers: [bridgeController as never],
      });

      eventHandler?.({
        type: "process-state-changed",
        sessionId: "thread-bridge",
        projectId: testProjectId,
        activity: "waiting-input",
        pendingInputType: "tool-approval",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "pending-input",
            sessionId: "thread-bridge",
            requestId: "req-bridge",
            inputType: "tool-approval",
          }),
          expect.any(Object),
        );
      });
    });

    it("skips absent bridge controllers and reads the next one", async () => {
      const request: InputRequest = {
        id: "req-oc",
        sessionId: "ses_oc",
        type: "question",
        prompt: "Pick one",
        toolName: "AskUserQuestion",
        toolInput: {},
        timestamp: new Date().toISOString(),
        source: "opencode-bridge",
      };
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(undefined);
      const emptyController = {
        getPendingInputRequest: vi.fn(async () => null),
      };
      const opencodeController = {
        getPendingInputRequest: vi.fn(async () => request),
      };

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
        bridgeControllers: [
          undefined,
          emptyController as never,
          opencodeController as never,
        ],
      });

      eventHandler?.({
        type: "process-state-changed",
        sessionId: "ses_oc",
        projectId: testProjectId,
        activity: "waiting-input",
        pendingInputType: "user-question",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "pending-input",
            sessionId: "ses_oc",
            requestId: undefined,
            inputType: "user-question",
            summary: "Question waiting — open Yep to answer",
          }),
          expect.any(Object),
        );
      });
    });
  });

  describe("summary building", () => {
    it("should build summary with file path for file operations", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Write?",
            toolName: "Write",
            toolInput: {
              file_path: "/home/user/project/src/components/Button.tsx",
            },
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary).toBe("Write: Button.tsx");
    });

    it("should build summary with just tool name when no file path", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Bash?",
            toolName: "Bash",
            toolInput: { command: "npm install" },
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary).toBe("Run: Bash");
    });

    it("names the subagent for a permission routed up from a child session", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "per_child",
            sessionId: "session-parent",
            type: "tool-approval",
            prompt: "Allow external_directory?",
            toolName: "external_directory",
            toolInput: {
              permission: "external_directory",
              patterns: ["/tmp/outside"],
              originSessionId: "ses_child",
              parentSessionId: "session-parent",
              originSessionTitle: "Explore open_platform_api_case project",
            },
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-parent",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      // Push targets the parent session but names the requesting subagent.
      expect(payload.sessionId).toBe("session-parent");
      expect(payload.summary).toBe(
        "Subagent Explore open_platform_api_case project — external_directory: /tmp/outside",
      );
    });

    it("uses a generic summary for long question prompts", async () => {
      const longPrompt =
        "This is a very long question that exceeds the maximum length we want to show in a push notification summary";

      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "question",
            prompt: longPrompt,
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary).toBe("Question waiting — open Yep to answer");
      expect(payload.inputType).toBe("user-question");
      expect(payload.requestId).toBeUndefined();
    });

    it("does not expose short question prompts", async () => {
      const shortPrompt = "What database should we use?";

      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "question",
            prompt: shortPrompt,
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.summary).toBe("Question waiting — open Yep to answer");
      expect(payload.requestId).toBeUndefined();
    });
  });

  describe("dismissal sync", () => {
    it("should send dismiss when process leaves waiting-input state", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      // First, enter waiting-input state (sends pending-input)
      const waitingEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(waitingEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      // Verify first call was pending-input
      const firstPayload = vi.mocked(mockPushService.sendToAll).mock
        .calls[0][0];
      expect(firstPayload.type).toBe("pending-input");

      // Now exit waiting-input state (should send dismiss)
      const runningEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "in-turn",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(runningEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(2);
      });

      // Verify second call was dismiss
      const secondPayload = vi.mocked(mockPushService.sendToAll).mock
        .calls[1][0];
      expect(secondPayload.type).toBe("dismiss");
      expect(secondPayload.sessionId).toBe("session-1");
    });

    it("should not send dismiss if no notification was sent for that session", async () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      // Directly send running event without going through waiting-input first
      const runningEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "in-turn",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(runningEvent);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not have sent anything
      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should not send dismiss when push sending failed", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      // Mock sendToAll to return no successful results
      vi.mocked(mockPushService.sendToAll).mockResolvedValue([
        {
          browserProfileId: "profile-1",
          success: false,
          error: "Network error",
        },
      ]);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      // Enter waiting-input state
      const waitingEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(waitingEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      // Clear mock to track dismiss calls
      vi.mocked(mockPushService.sendToAll).mockClear();

      // Exit waiting-input state
      const runningEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "in-turn",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(runningEvent);

      // Give async processing a chance
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not have sent dismiss since no notification was successfully sent
      expect(mockPushService.sendToAll).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("should still send session-halted after an unsuccessful pending-input notification", async () => {
      const waitingProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "user-question",
            prompt: "Need confirmation",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };
      const idleProcess = {
        state: { type: "idle", since: new Date() } as ProcessState,
        startedAt: new Date(Date.now() - 10_000),
        getMessageHistory: vi.fn(() => [
          {
            type: "user",
            message: { content: "Implement native notifications" },
          },
        ]),
      };

      vi.mocked(mockSupervisor.getProcessForSession)
        .mockReturnValueOnce(
          waitingProcess as unknown as ReturnType<
            Supervisor["getProcessForSession"]
          >,
        )
        .mockReturnValue(
          idleProcess as unknown as ReturnType<
            Supervisor["getProcessForSession"]
          >,
        );

      vi.mocked(mockPushService.sendToAll)
        .mockResolvedValueOnce([
          {
            browserProfileId: "profile-1",
            success: false,
            error: "Network error",
          },
        ])
        .mockResolvedValueOnce([
          { browserProfileId: "profile-1", success: true },
        ]);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      const waitingEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };
      eventHandler?.(waitingEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      const idleEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "idle",
        timestamp: new Date().toISOString(),
      };
      eventHandler?.(idleEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(2);
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[1][0];
      expect(payload.type).toBe("session-halted");
      expect(payload.sessionId).toBe("session-1");
      expect(
        mockNotificationService.markSessionNeedsReview,
      ).toHaveBeenCalledWith("session-1", idleEvent.timestamp);
    });

    it("should send session-halted when a session becomes idle", async () => {
      const mockProcess = {
        state: { type: "idle", since: new Date() } as ProcessState,
        startedAt: new Date(Date.now() - 10_000),
        getMessageHistory: vi.fn(() => [
          {
            type: "user",
            message: { content: "Implement native notifications" },
          },
        ]),
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      const idleEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "idle",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(idleEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.type).toBe("session-halted");
      expect(payload.sessionId).toBe("session-1");
      expect(payload.projectName).toBe("test-project");
      expect(payload.sessionTitle).toBe("Implement native notifications");
      expect(payload.reason).toBe("completed");
      expect(
        mockNotificationService.markSessionNeedsReview,
      ).toHaveBeenCalledWith("session-1", idleEvent.timestamp);
    });

    it("should use the cached process session title after the process is gone", async () => {
      const runningProcess = {
        state: { type: "in-turn" } as ProcessState,
        startedAt: new Date(Date.now() - 10_000),
        getMessageHistory: vi.fn(() => [
          {
            type: "user",
            message: { content: "Cached process title" },
          },
        ]),
      };

      vi.mocked(mockSupervisor.getProcessForSession)
        .mockReturnValueOnce(
          runningProcess as unknown as ReturnType<
            Supervisor["getProcessForSession"]
          >,
        )
        .mockReturnValue(undefined);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      const runningEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "in-turn",
        timestamp: new Date().toISOString(),
      };
      eventHandler?.(runningEvent);

      await vi.waitFor(() => {
        expect(mockSupervisor.getProcessForSession).toHaveBeenCalledTimes(1);
      });

      const idleEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "idle",
        timestamp: new Date().toISOString(),
      };
      eventHandler?.(idleEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.type).toBe("session-halted");
      expect(payload.sessionTitle).toBe("Cached process title");
    });

    it("should use session-updated titles for halted sessions without a supervisor process", async () => {
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(undefined);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      eventHandler?.({
        type: "session-updated",
        sessionId: "session-1",
        projectId: testProjectId,
        title: "Existing bridge session",
        updatedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      });

      const idleEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "idle",
        timestamp: new Date().toISOString(),
      };
      eventHandler?.(idleEvent);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.type).toBe("session-halted");
      expect(payload.sessionTitle).toBe("Existing bridge session");
    });

    it("does not let a provider update replace a cached Yep AI title", async () => {
      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(undefined);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      eventHandler?.({
        type: "session-metadata-changed",
        sessionId: "session-1",
        aiTitle: "Yep AI title",
        timestamp: new Date().toISOString(),
      });
      eventHandler?.({
        type: "session-updated",
        sessionId: "session-1",
        projectId: testProjectId,
        title: "Provider fallback title",
        timestamp: new Date().toISOString(),
      });
      eventHandler?.({
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "idle",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.type).toBe("session-halted");
      expect(payload.sessionTitle).toBe("Yep AI title");
    });

    it("should still mark session-halted badge state without push subscriptions", async () => {
      vi.mocked(mockPushService.getSubscriptionCount).mockReturnValue(0);

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        notificationService: mockNotificationService,
        supervisor: mockSupervisor,
      });

      const idleEvent: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "idle",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(idleEvent);

      await vi.waitFor(() => {
        expect(
          mockNotificationService.markSessionNeedsReview,
        ).toHaveBeenCalledWith("session-1", idleEvent.timestamp);
      });
      expect(mockPushService.sendToAll).not.toHaveBeenCalled();
    });

    it("should send dismiss when a session is marked seen", async () => {
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      eventHandler?.({
        type: "session-seen",
        sessionId: "session-1",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(mockPushService.sendToAll).mock.calls[0][0];
      expect(payload.type).toBe("dismiss");
      expect(payload.sessionId).toBe("session-1");
    });
  });

  describe("error handling", () => {
    it("should handle push service errors gracefully", async () => {
      vi.mocked(mockPushService.sendToAll).mockRejectedValue(
        new Error("Network error"),
      );

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("[PushNotifier]"),
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });
  });

  describe("connected browser filtering", () => {
    it("should exclude connected browser profiles from push", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      // Mock connected browsers service
      const mockConnectedBrowsers = {
        getConnectedBrowserProfileIds: vi.fn(() => ["connected-profile-1"]),
      };

      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
        connectedBrowsers: mockConnectedBrowsers as unknown as Parameters<
          typeof PushNotifier
        >[0]["connectedBrowsers"],
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      // Verify sendToAll was called with exclude option
      const options = vi.mocked(mockPushService.sendToAll).mock.calls[0][1];
      expect(options?.excludeBrowserProfileIds).toEqual([
        "connected-profile-1",
      ]);
    });

    it("should send to all when no connectedBrowsers service", async () => {
      const mockProcess = {
        state: {
          type: "waiting-input",
          request: {
            id: "req-1",
            sessionId: "session-1",
            type: "tool-approval",
            prompt: "Allow Edit?",
            toolName: "Edit",
            timestamp: new Date().toISOString(),
          } as InputRequest,
        } as ProcessState,
      };

      vi.mocked(mockSupervisor.getProcessForSession).mockReturnValue(
        mockProcess as unknown as ReturnType<
          Supervisor["getProcessForSession"]
        >,
      );

      // No connectedBrowsers service provided
      new PushNotifier({
        eventBus: mockEventBus,
        pushService: mockPushService,
        supervisor: mockSupervisor,
      });

      const event: ProcessStateEvent = {
        type: "process-state-changed",
        sessionId: "session-1",
        projectId: testProjectId,
        activity: "waiting-input",
        timestamp: new Date().toISOString(),
      };

      eventHandler?.(event);

      await vi.waitFor(() => {
        expect(mockPushService.sendToAll).toHaveBeenCalled();
      });

      // Verify sendToAll was called with empty exclude list
      const options = vi.mocked(mockPushService.sendToAll).mock.calls[0][1];
      expect(options?.excludeBrowserProfileIds).toEqual([]);
    });
  });
});
