import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuDurableInbox } from "../../../src/channels/feishu/inbox.js";
import type { FeishuInteractionManager } from "../../../src/channels/feishu/interaction-manager.js";
import type { FeishuMessageApi } from "../../../src/channels/feishu/normalization/types.js";
import type { FeishuOutboundApi } from "../../../src/channels/feishu/outbound.js";
import { FeishuReplyManager } from "../../../src/channels/feishu/reply-manager.js";
import { FeishuStatusRegistry } from "../../../src/channels/feishu/status.js";
import type { SessionCommandService } from "../../../src/services/SessionCommandService.js";
import type { UploadManager } from "../../../src/uploads/manager.js";

describe("FeishuReplyManager", () => {
  const dataDirs: string[] = [];
  const managers: FeishuReplyManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("subscribes before dispatch and completes inbox only at runtime terminal", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const completeInbox = vi.spyOn(inbox, "complete");
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    const cleanup = vi.fn();
    const projectPendingInput = vi.fn(async () => undefined);
    const subscribe = vi.fn(async (_sessionId, nextEmit) => {
      emit = nextEmit;
      return { cleanup };
    });
    const manager = new FeishuReplyManager({
      sessionCommandService: { subscribe } as unknown as SessionCommandService,
      inbox,
      interactionManager: {
        projectPendingInput,
      } as unknown as FeishuInteractionManager,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const api = makeApi();
    const handle = await manager.startTurn({
      accountId: "team-bot",
      scopeKey: "team-bot:p2p:oc_chat",
      projectId: "project-1",
      sessionId: "session-1",
      tempId: record.tempId,
      inboxKeys: [record.key],
      replyMode: "card",
      requesterOpenId: "ou_user",
      allowedOperatorOpenIds: ["ou_user"],
      api,
      target: {
        chatId: "oc_chat",
        replyToMessageId: "om_inbound",
        replyInThread: false,
      },
    });
    const terminalCleanup = vi.fn(async () => undefined);
    handle.addTerminalCleanup(terminalCleanup);

    expect(subscribe).toHaveBeenCalledWith(
      "session-1",
      expect.any(Function),
      expect.objectContaining({ logLabel: "feishu:team-bot" }),
    );
    expect(api.createStreamingReply).toHaveBeenCalled();
    expect(inbox.get(record.key)?.status).toBe("dispatched");
    emit?.("connected", {
      state: "waiting-input",
      request: {
        id: "old-request",
        sessionId: "session-1",
        type: "tool-approval",
        prompt: "Old approval",
        timestamp: new Date().toISOString(),
      },
    });
    await handle.dispatchAccepted();
    expect(projectPendingInput).not.toHaveBeenCalled();
    emit?.("message", userRuntimeMessage(record.tempId));
    emit?.("status", {
      state: "waiting-input",
      request: {
        id: "request-1",
        sessionId: "session-1",
        type: "tool-approval",
        prompt: "Allow Bash?",
        timestamp: new Date().toISOString(),
      },
    });
    await eventually(() =>
      expect(projectPendingInput).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "team-bot",
          sessionId: "session-1",
          requesterOpenId: "ou_user",
        }),
        expect.objectContaining({ id: "request-1" }),
      ),
    );
    emit?.("message", {
      type: "assistant",
      message: { content: "Runtime answer" },
    });
    emit?.("status", { state: "idle" });

    await eventually(() =>
      expect(inbox.get(record.key)?.status).toBe("completed"),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(api.finishStreamingReply).toHaveBeenCalled();
    expect(completeInbox).toHaveBeenCalledTimes(1);
    expect(terminalCleanup).toHaveBeenCalledTimes(1);
    emit?.("status", { state: "idle" });
    await drainRuntimeEvents();
    expect(terminalCleanup).toHaveBeenCalledTimes(1);
  });

  it("defers a fresh-turn subscription until atomic start returns the real session", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const subscribe = vi.fn(async () => ({ cleanup: vi.fn() }));
    const manager = new FeishuReplyManager({
      sessionCommandService: { subscribe } as unknown as SessionCommandService,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const input = {
      ...makeTurnInput(record),
      sessionId: record.tempId,
      deferSubscription: true,
    };

    const handle = await manager.startTurn(input);

    expect(subscribe).not.toHaveBeenCalled();
    await handle.dispatchAccepted("session-real", {
      processId: "process-real",
      restarted: false,
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(
      "session-real",
      expect.any(Function),
      expect.objectContaining({ logLabel: "feishu:team-bot" }),
    );
  });

  it("rebinds an eager subscription when atomic dispatch returns another session", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const cleanups = [vi.fn(), vi.fn()];
    const subscribe = vi.fn(async () => ({
      cleanup: cleanups[subscribe.mock.calls.length - 1] ?? vi.fn(),
    }));
    const manager = new FeishuReplyManager({
      sessionCommandService: { subscribe } as unknown as SessionCommandService,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);

    const handle = await manager.startTurn(makeTurnInput(record));
    expect(subscribe).toHaveBeenNthCalledWith(
      1,
      "session-1",
      expect.any(Function),
      expect.any(Object),
    );

    await handle.dispatchAccepted("session-real", {
      processId: "process-real",
      restarted: false,
    });

    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenNthCalledWith(
      2,
      "session-real",
      expect.any(Function),
      expect.any(Object),
    );
  });

  it("keeps dispatched work recoverable when the server shuts down", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const cleanup = vi.fn();
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async () => ({ cleanup })),
      } as unknown as SessionCommandService,
      inbox,
    });
    managers.push(manager);
    await manager.restoreTurn({
      accountId: "team-bot",
      scopeKey: "team-bot:p2p:oc_chat",
      projectId: "project-1",
      sessionId: "session-1",
      tempId: record.tempId,
      inboxKeys: [record.key],
      replyMode: "text",
      requesterOpenId: "ou_user",
      allowedOperatorOpenIds: ["ou_user"],
      api: makeApi(),
      target: {
        chatId: "oc_chat",
        replyToMessageId: "om_inbound",
        replyInThread: false,
      },
    });

    await manager.shutdown();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(inbox.get(record.key)?.status).toBe("dispatched");
  });

  it("resolves opaque generated artifacts only within the bound project and session", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    const bytes = Buffer.from("%PDF-1.7\n");
    const readGeneratedArtifactBytes = vi.fn(async () => ({ bytes }));
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, nextEmit) => {
          emit = nextEmit;
          return { cleanup: vi.fn() };
        }),
      } as unknown as SessionCommandService,
      inbox,
      uploadManager: {
        readGeneratedArtifactBytes,
      } as unknown as UploadManager,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const input = makeTurnInput(record);
    const api = input.api;
    const handle = await manager.startTurn(input);
    await handle.dispatchAccepted();
    emit?.("message", userRuntimeMessage(record.tempId));
    const artifactMessage = managedFileRuntimeMessage(bytes.length);
    emit?.("message", artifactMessage);

    await eventually(() =>
      expect(readGeneratedArtifactBytes).toHaveBeenCalledWith(
        { projectId: "project-1", sessionId: "session-1" },
        expect.objectContaining({
          artifactId: artifactMessage.codexGeneratedArtifacts[0].id,
          managedRef: "upload:123e4567-e89b-12d3-a456-426614174000",
          mimeType: "application/pdf",
          sha256: artifactMessage.codexGeneratedArtifacts[0].sha256,
          sizeBytes: bytes.length,
        }),
      ),
    );
    await eventually(() =>
      expect(api.sendFileReply).toHaveBeenCalledWith(
        input.target,
        expect.objectContaining({
          deliveryIdentity: expect.objectContaining({
            accountId: "team-bot",
            sessionId: "session-1",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "file-1",
            artifactId: artifactMessage.codexGeneratedArtifacts[0].id,
          }),
        }),
      ),
    );
  });

  it("persists runtime failure as a failed inbox terminal instead of completed", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    const statusRegistry = new FeishuStatusRegistry();
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, nextEmit) => {
          emit = nextEmit;
          return { cleanup: vi.fn() };
        }),
      } as unknown as SessionCommandService,
      inbox,
      statusRegistry,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn({
      accountId: "team-bot",
      scopeKey: "team-bot:p2p:oc_chat",
      projectId: "project-1",
      sessionId: "session-1",
      tempId: record.tempId,
      inboxKeys: [record.key],
      replyMode: "text",
      requesterOpenId: "ou_user",
      allowedOperatorOpenIds: ["ou_user"],
      api: makeApi(),
      target: {
        chatId: "oc_chat",
        replyToMessageId: "om_inbound",
        replyInThread: false,
      },
    });
    await handle.dispatchAccepted();
    emit?.("message", userRuntimeMessage(record.tempId));
    emit?.("error", { code: "transport_closed" });
    emit?.("error", { code: "late_duplicate_failure" });
    emit?.("complete", { reason: "late_duplicate_completion" });

    await eventually(() =>
      expect(inbox.get(record.key)).toMatchObject({
        status: "failed",
        lastErrorCode: "RUNTIME_FAILED",
      }),
    );
    expect(statusRegistry.get("team-bot")?.metrics.messagesFailed).toBe(1);
  });

  it("counts each unique failed inbox message once for a batched runtime turn", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const { record: secondRecord } = await inbox.receive({
      accountId: "team-bot",
      eventId: "evt_inbound_2",
      eventType: "im.message.receive_v1",
      messageId: "om_inbound_2",
      scopeKey: "team-bot:p2p:oc_chat",
    });
    await inbox.beginDispatch(secondRecord.key, {
      scopeKey: "team-bot:p2p:oc_chat",
      sessionId: "session-1",
    });
    await inbox.markDispatched(secondRecord.key, { sessionId: "session-1" });
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    const statusRegistry = new FeishuStatusRegistry();
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, nextEmit) => {
          emit = nextEmit;
          return { cleanup: vi.fn() };
        }),
      } as unknown as SessionCommandService,
      inbox,
      statusRegistry,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn({
      ...makeTurnInput(record),
      inboxKeys: [record.key, secondRecord.key, record.key],
    });
    await handle.dispatchAccepted();
    emit?.("message", userRuntimeMessage(record.tempId));
    emit?.("error", { code: "transport_closed" });

    await eventually(() => {
      expect(inbox.get(record.key)?.status).toBe("failed");
      expect(inbox.get(secondRecord.key)?.status).toBe("failed");
    });
    expect(statusRegistry.get("team-bot")?.metrics.messagesFailed).toBe(2);
  });

  it("keeps old-turn terminals and pending input from completing queued B", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const completeInbox = vi.spyOn(inbox, "complete");
    const failInbox = vi.spyOn(inbox, "fail");
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    const projectPendingInput = vi.fn(async () => undefined);
    const reconcileOpenOperations = vi.fn(async () => 0);
    const terminateOpenOperations = vi.fn(async () => 0);
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, nextEmit) => {
          emit = nextEmit;
          return { cleanup: vi.fn() };
        }),
      } as unknown as SessionCommandService,
      inbox,
      interactionManager: {
        projectPendingInput,
        reconcileOpenOperations,
        terminateOpenOperations,
      } as unknown as FeishuInteractionManager,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn(makeTurnInput(record));
    const optimisticB = userRuntimeMessage(record.tempId, "turn-b");
    Reflect.deleteProperty(optimisticB, "turnId");
    Reflect.deleteProperty(optimisticB, "codexTurnId");

    // Process publishes B's client identity before a queued turn/start has
    // returned. A can still emit status and scoped terminal messages here.
    emit?.("message", { ...optimisticB, isOptimistic: true });
    emit?.("status", {
      state: "waiting-input",
      request: {
        ...makePendingRequest(),
        id: "request-a",
        prompt: "Old A approval",
      },
    });
    emit?.("message", {
      type: "error",
      turnId: "turn-a",
      error: "old A failed",
    });
    emit?.("message", {
      type: "result",
      turnId: "turn-a",
      clientUserMessageId: "client-a",
    });
    emit?.("status", { state: "idle" });

    await handle.dispatchAccepted();
    await drainRuntimeEvents();
    expect(inbox.get(record.key)?.status).toBe("dispatched");
    expect(completeInbox).not.toHaveBeenCalled();
    expect(failInbox).not.toHaveBeenCalled();
    expect(projectPendingInput).not.toHaveBeenCalled();
    expect(reconcileOpenOperations).not.toHaveBeenCalled();
    expect(terminateOpenOperations).not.toHaveBeenCalled();

    // Only B's provider echo establishes the turn. A late scoped error remains
    // ignored, while B's matching terminal completes the durable inbox once.
    emit?.("message", userRuntimeMessage(record.tempId, "turn-b"));
    emit?.("message", {
      type: "error",
      turnId: "turn-a",
      error: "late old A failure",
    });
    emit?.("message", {
      type: "system",
      subtype: "turn_complete",
      turnId: "turn-b",
      turnStatus: "completed",
    });

    await eventually(() =>
      expect(inbox.get(record.key)?.status).toBe("completed"),
    );
    expect(completeInbox).toHaveBeenCalledTimes(1);
    expect(failInbox).not.toHaveBeenCalled();
    expect(terminateOpenOperations).not.toHaveBeenCalled();
  });

  it("hands a planned restart from process A to B without leaking A's terminal", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const completeInbox = vi.spyOn(inbox, "complete");
    const failInbox = vi.spyOn(inbox, "fail");
    const subscriptions: Array<{
      emit: (eventType: string, data: unknown) => void;
      cleanup: ReturnType<typeof vi.fn>;
    }> = [];
    const subscribe = vi.fn(async (_sessionId, emit) => {
      const cleanup = vi.fn();
      subscriptions.push({ emit, cleanup });
      emit("connected", {
        processId: `process-${subscriptions.length === 1 ? "a" : "b"}`,
        sessionId: "session-1",
        state: "in-turn",
      });
      return { cleanup };
    });
    const manager = new FeishuReplyManager({
      sessionCommandService: { subscribe } as unknown as SessionCommandService,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const input = makeTurnInput(record);
    const api = input.api;
    const handle = await manager.startTurn(input);
    const processA = subscriptions[0];
    expect(processA).toBeDefined();

    // Supervisor aborts A as part of the accepted queue operation. Its complete
    // can race ahead of the HTTP/send result, but it is not B's turn terminal.
    processA?.emit("complete", { plannedRestart: true });
    await drainRuntimeEvents();
    await handle.dispatchAccepted("session-1", {
      processId: "process-b",
      restarted: true,
    });

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(processA?.cleanup).toHaveBeenCalledTimes(1);
    const processB = subscriptions[1];
    expect(processB).toBeDefined();
    processA?.emit("error", { message: "stale process A error" });
    processA?.emit("message", {
      ...userRuntimeMessage(record.tempId),
      isReplay: true,
    });
    processA?.emit("message", {
      type: "result",
      turnId: "turn-1",
      session_id: "session-1",
      isReplay: true,
    });
    await drainRuntimeEvents();
    expect(inbox.get(record.key)?.status).toBe("dispatched");
    processB?.emit("message", userRuntimeMessage(record.tempId));
    processB?.emit("message", {
      type: "system",
      subtype: "turn_complete",
      turnId: "turn-1",
      turnStatus: "completed",
    });
    // Later B lifecycle signals must not append a second inbox terminal.
    processB?.emit("error", { message: "late B error" });
    processB?.emit("complete", { timestamp: new Date().toISOString() });

    await eventually(() =>
      expect(inbox.get(record.key)?.status).toBe("completed"),
    );
    expect(completeInbox).toHaveBeenCalledTimes(1);
    expect(failInbox).not.toHaveBeenCalled();
    expect(processB?.cleanup).toHaveBeenCalledTimes(1);
    expect(api?.finishStreamingReply).toHaveBeenCalledTimes(1);
  });

  it("completes a fast replacement B from replayed result exactly once", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const completeInbox = vi.spyOn(inbox, "complete");
    const failInbox = vi.spyOn(inbox, "fail");
    let processAEmit: ((eventType: string, data: unknown) => void) | undefined;
    const processACleanup = vi.fn();
    let processBEmit: ((eventType: string, data: unknown) => void) | undefined;
    const processBCleanup = vi.fn();
    const subscribe = vi
      .fn()
      .mockImplementationOnce(async (_sessionId, emit) => {
        processAEmit = emit;
        emit("connected", {
          processId: "process-a",
          sessionId: "session-1",
          state: "in-turn",
        });
        return { cleanup: processACleanup };
      })
      .mockImplementationOnce(async (_sessionId, emit) => {
        processBEmit = emit;
        emit("connected", {
          processId: "process-b",
          sessionId: "session-1",
          state: "idle",
        });
        emit("message", {
          ...userRuntimeMessage(record.tempId),
          isReplay: true,
        });
        emit("message", {
          type: "result",
          turnId: "turn-1",
          session_id: "session-1",
          isReplay: true,
        });
        return { cleanup: processBCleanup };
      });
    const manager = new FeishuReplyManager({
      sessionCommandService: { subscribe } as unknown as SessionCommandService,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn(makeTurnInput(record));
    processAEmit?.("complete", { plannedRestart: true });
    await drainRuntimeEvents();

    await handle.dispatchAccepted("session-1", {
      processId: "process-b",
      restarted: true,
    });

    await eventually(() =>
      expect(inbox.get(record.key)?.status).toBe("completed"),
    );
    // Conflicting late terminal evidence from the same replacement must not
    // overwrite or append another durable terminal.
    processBEmit?.("message", {
      type: "system",
      subtype: "turn_complete",
      turnId: "turn-1",
      turnStatus: "failed",
    });
    processBEmit?.("error", { message: "late replacement error" });
    processBEmit?.("complete", { timestamp: new Date().toISOString() });
    await drainRuntimeEvents();

    expect(processACleanup).toHaveBeenCalledTimes(1);
    expect(processBCleanup).toHaveBeenCalledTimes(1);
    expect(completeInbox).toHaveBeenCalledTimes(1);
    expect(failInbox).not.toHaveBeenCalled();
  });

  it("fails exactly once when replacement process B errors", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const completeInbox = vi.spyOn(inbox, "complete");
    const failInbox = vi.spyOn(inbox, "fail");
    const subscriptions: Array<{
      emit: (eventType: string, data: unknown) => void;
      cleanup: ReturnType<typeof vi.fn>;
    }> = [];
    const subscribe = vi.fn(async (_sessionId, emit) => {
      const cleanup = vi.fn();
      subscriptions.push({ emit, cleanup });
      emit("connected", {
        processId: `process-${subscriptions.length === 1 ? "a" : "b"}`,
        sessionId: "session-1",
        state: "in-turn",
      });
      return { cleanup };
    });
    const manager = new FeishuReplyManager({
      sessionCommandService: { subscribe } as unknown as SessionCommandService,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn(makeTurnInput(record));
    subscriptions[0]?.emit("complete", { plannedRestart: true });
    await drainRuntimeEvents();

    await handle.dispatchAccepted("session-1", {
      processId: "process-b",
      restarted: true,
    });
    const processB = subscriptions[1];
    processB?.emit("message", userRuntimeMessage(record.tempId));
    processB?.emit("error", { message: "replacement failed" });
    processB?.emit("message", {
      type: "result",
      turnId: "turn-1",
      session_id: "session-1",
    });
    processB?.emit("message", {
      type: "system",
      subtype: "turn_complete",
      turnId: "turn-1",
      turnStatus: "completed",
    });
    processB?.emit("complete", { timestamp: new Date().toISOString() });

    await eventually(() =>
      expect(inbox.get(record.key)).toMatchObject({
        status: "failed",
        lastErrorCode: "RUNTIME_FAILED",
      }),
    );
    expect(failInbox).toHaveBeenCalledTimes(1);
    expect(completeInbox).not.toHaveBeenCalled();
    expect(processB?.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails closed when replacement process B cannot be subscribed", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const completeInbox = vi.spyOn(inbox, "complete");
    const failInbox = vi.spyOn(inbox, "fail");
    let processAEmit: ((eventType: string, data: unknown) => void) | undefined;
    const processACleanup = vi.fn();
    const subscribe = vi
      .fn()
      .mockImplementationOnce(async (_sessionId, emit) => {
        processAEmit = emit;
        emit("connected", {
          processId: "process-a",
          sessionId: "session-1",
          state: "idle",
        });
        return { cleanup: processACleanup };
      })
      .mockResolvedValueOnce(null);
    const manager = new FeishuReplyManager({
      sessionCommandService: { subscribe } as unknown as SessionCommandService,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn(makeTurnInput(record));
    processAEmit?.("complete", { plannedRestart: true });
    await drainRuntimeEvents();

    await handle.dispatchAccepted("session-1", {
      processId: "process-b",
      restarted: true,
    });

    await eventually(() =>
      expect(inbox.get(record.key)).toMatchObject({
        status: "failed",
        lastErrorCode: "RUNTIME_FAILED",
      }),
    );
    expect(processACleanup).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(failInbox).toHaveBeenCalledTimes(1);
    expect(completeInbox).not.toHaveBeenCalled();
  });

  it("finishes a recovered card from an offline durable replay", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    const cleanup = vi.fn();
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, emit) => {
          emit("connected", {
            sessionId: "session-1",
            state: "idle",
            replayOnly: true,
          });
          emit("message", {
            ...userRuntimeMessage(record.tempId),
            isReplay: true,
          });
          emit("message", {
            type: "assistant",
            isReplay: true,
            message: { content: "Recovered answer" },
          });
          emit("message", {
            type: "system",
            subtype: "turn_complete",
            turnId: "turn-1",
            turnStatus: "completed",
            isReplay: true,
          });
          emit("complete", { replayOnly: true });
          return { cleanup };
        }),
      } as unknown as SessionCommandService,
      inbox,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const api = makeApi();

    await expect(
      manager.restoreTurn({
        accountId: "team-bot",
        scopeKey: "team-bot:p2p:oc_chat",
        projectId: "project-1",
        sessionId: "session-1",
        tempId: record.tempId,
        inboxKeys: [record.key],
        replyMode: "card",
        requesterOpenId: "ou_user",
        allowedOperatorOpenIds: ["ou_user"],
        api,
        target: {
          chatId: "oc_chat",
          replyToMessageId: "om_inbound",
          replyInThread: false,
        },
      }),
    ).resolves.toBe(true);

    await eventually(() =>
      expect(inbox.get(record.key)?.status).toBe("completed"),
    );
    expect(api.finishStreamingReply).toHaveBeenCalledWith(
      "card-1",
      expect.any(Number),
      expect.stringContaining("Recovered answer"),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reconciles the active operation when waiting-input leaves", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    const projectPendingInput = vi.fn(async () => undefined);
    const reconcileOpenOperations = vi.fn(async () => 1);
    const terminateOpenOperations = vi.fn(async () => 0);
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, nextEmit) => {
          emit = nextEmit;
          return { cleanup: vi.fn() };
        }),
      } as unknown as SessionCommandService,
      inbox,
      interactionManager: {
        projectPendingInput,
        reconcileOpenOperations,
        terminateOpenOperations,
      } as unknown as FeishuInteractionManager,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn(makeTurnInput(record));
    await handle.dispatchAccepted();
    emit?.("message", userRuntimeMessage(record.tempId));
    emit?.("status", {
      state: "waiting-input",
      request: makePendingRequest(),
    });
    await eventually(() =>
      expect(projectPendingInput).toHaveBeenCalledTimes(1),
    );

    emit?.("status", { state: "in-turn" });

    await eventually(() =>
      expect(reconcileOpenOperations).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "team-bot",
          sessionId: "session-1",
          requestId: "request-1",
        }),
        null,
      ),
    );
    expect(terminateOpenOperations).not.toHaveBeenCalled();
  });

  it("serializes a pending-input projection before terminal reconciliation", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    let releaseProjection: (() => void) | undefined;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const projectPendingInput = vi.fn(async () => projectionGate);
    const terminateOpenOperations = vi.fn(async () => 1);
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, nextEmit) => {
          emit = nextEmit;
          return { cleanup: vi.fn() };
        }),
      } as unknown as SessionCommandService,
      inbox,
      interactionManager: {
        projectPendingInput,
        reconcileOpenOperations: vi.fn(async () => 0),
        terminateOpenOperations,
      } as unknown as FeishuInteractionManager,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn(makeTurnInput(record));
    await handle.dispatchAccepted();
    emit?.("message", userRuntimeMessage(record.tempId));
    emit?.("status", { state: "waiting-input", request: makePendingRequest() });
    await eventually(() => expect(projectPendingInput).toHaveBeenCalled());

    emit?.("error", { message: "synthetic runtime failure" });
    await drainRuntimeEvents();
    expect(terminateOpenOperations).not.toHaveBeenCalled();

    releaseProjection?.();
    await eventually(() =>
      expect(terminateOpenOperations).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "request-1" }),
        "failed",
      ),
    );
  });

  it("terminates active operations when a session is interrupted", async () => {
    const { inbox, record } = await createDispatchedRecord(dataDirs);
    let emit: ((eventType: string, data: unknown) => void) | undefined;
    const terminateOpenOperations = vi.fn(async () => 1);
    const statusRegistry = new FeishuStatusRegistry();
    const manager = new FeishuReplyManager({
      sessionCommandService: {
        subscribe: vi.fn(async (_sessionId, nextEmit) => {
          emit = nextEmit;
          return { cleanup: vi.fn() };
        }),
      } as unknown as SessionCommandService,
      inbox,
      interactionManager: {
        projectPendingInput: vi.fn(async () => undefined),
        reconcileOpenOperations: vi.fn(async () => 0),
        terminateOpenOperations,
      } as unknown as FeishuInteractionManager,
      statusRegistry,
      controllerOptions: { throttleMs: 0 },
    });
    managers.push(manager);
    const handle = await manager.startTurn(makeTurnInput(record));
    await handle.dispatchAccepted();
    emit?.("message", userRuntimeMessage(record.tempId));
    emit?.("status", {
      state: "waiting-input",
      request: makePendingRequest(),
    });

    await manager.interruptSession("session-1");

    expect(terminateOpenOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "team-bot",
        sessionId: "session-1",
        requestId: "request-1",
      }),
      "interrupt",
    );
    expect(inbox.get(record.key)).toMatchObject({
      status: "failed",
      lastErrorCode: "TURN_INTERRUPTED",
    });
    expect(statusRegistry.get("team-bot")?.metrics.messagesFailed).toBe(0);
  });

  it.each([
    ["error", { code: "transport_closed" }, "failed"],
    ["status", { state: "terminated" }, "process_exit"],
    [
      "message",
      {
        type: "system",
        subtype: "turn_complete",
        turnId: "turn-1",
        turnStatus: "interrupted",
      },
      "interrupt",
    ],
  ] as const)(
    "terminates active operations on runtime %s",
    async (eventType, data, reason) => {
      const { inbox, record } = await createDispatchedRecord(dataDirs);
      let emit: ((eventType: string, data: unknown) => void) | undefined;
      const terminateOpenOperations = vi.fn(async () => 1);
      const manager = new FeishuReplyManager({
        sessionCommandService: {
          subscribe: vi.fn(async (_sessionId, nextEmit) => {
            emit = nextEmit;
            return { cleanup: vi.fn() };
          }),
        } as unknown as SessionCommandService,
        inbox,
        interactionManager: {
          projectPendingInput: vi.fn(async () => undefined),
          reconcileOpenOperations: vi.fn(async () => 0),
          terminateOpenOperations,
        } as unknown as FeishuInteractionManager,
        controllerOptions: { throttleMs: 0 },
      });
      managers.push(manager);
      const handle = await manager.startTurn(makeTurnInput(record));
      await handle.dispatchAccepted();
      emit?.("message", userRuntimeMessage(record.tempId));
      emit?.("status", {
        state: "waiting-input",
        request: makePendingRequest(),
      });

      emit?.(eventType, data);

      await eventually(() =>
        expect(terminateOpenOperations).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: "request-1" }),
          reason,
        ),
      );
    },
  );

  it.each([true, false])(
    "fails a generic runtime complete even with turn echo=%s",
    async (withTurnEcho) => {
      const { inbox, record } = await createDispatchedRecord(dataDirs);
      let emit: ((eventType: string, data: unknown) => void) | undefined;
      const reconcileOpenOperations = vi.fn(async () => 1);
      const terminateOpenOperations = vi.fn(async () => 1);
      const manager = new FeishuReplyManager({
        sessionCommandService: {
          subscribe: vi.fn(async (_sessionId, nextEmit) => {
            emit = nextEmit;
            return { cleanup: vi.fn() };
          }),
        } as unknown as SessionCommandService,
        inbox,
        interactionManager: {
          projectPendingInput: vi.fn(async () => undefined),
          reconcileOpenOperations,
          terminateOpenOperations,
        } as unknown as FeishuInteractionManager,
        controllerOptions: { throttleMs: 0 },
      });
      managers.push(manager);
      const handle = await manager.startTurn(makeTurnInput(record));
      await handle.dispatchAccepted();
      if (withTurnEcho) {
        emit?.("message", userRuntimeMessage(record.tempId));
      }
      emit?.("status", {
        state: "waiting-input",
        request: makePendingRequest(),
      });

      emit?.("complete", { timestamp: new Date().toISOString() });

      await eventually(() =>
        expect(terminateOpenOperations).toHaveBeenCalledWith(
          expect.objectContaining({
            requestId: withTurnEcho ? "request-1" : undefined,
          }),
          "failed",
        ),
      );
      expect(reconcileOpenOperations).not.toHaveBeenCalledWith(
        expect.anything(),
        null,
      );
    },
  );
});

function makeTurnInput(record: { tempId: string; key: string }) {
  return {
    accountId: "team-bot",
    scopeKey: "team-bot:p2p:oc_chat",
    projectId: "project-1",
    sessionId: "session-1",
    tempId: record.tempId,
    inboxKeys: [record.key],
    replyMode: "card" as const,
    requesterOpenId: "ou_user",
    allowedOperatorOpenIds: ["ou_user"],
    api: makeApi(),
    target: {
      chatId: "oc_chat",
      replyToMessageId: "om_inbound",
      replyInThread: false,
    },
  };
}

function makePendingRequest() {
  return {
    id: "request-1",
    sessionId: "session-1",
    type: "tool-approval" as const,
    prompt: "Allow Bash?",
    timestamp: new Date().toISOString(),
  };
}

async function createDispatchedRecord(dataDirs: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-reply-manager-"));
  dataDirs.push(dataDir);
  const inbox = new FeishuDurableInbox({ dataDir });
  await inbox.initialize();
  const { record } = await inbox.receive({
    accountId: "team-bot",
    eventId: "evt_inbound",
    eventType: "im.message.receive_v1",
    messageId: "om_inbound",
    scopeKey: "team-bot:p2p:oc_chat",
  });
  await inbox.beginDispatch(record.key, {
    scopeKey: "team-bot:p2p:oc_chat",
    sessionId: "session-1",
  });
  await inbox.markDispatched(record.key, { sessionId: "session-1" });
  return { inbox, record };
}

function makeApi(): FeishuMessageApi &
  FeishuOutboundApi & {
    createStreamingReply: ReturnType<typeof vi.fn>;
    finishStreamingReply: ReturnType<typeof vi.fn>;
    sendFileReply: ReturnType<typeof vi.fn>;
  } {
  return {
    fetchMessageItems: vi.fn(async () => []),
    createStreamingReply: vi.fn(async () => ({
      cardId: "card-1",
      messageId: "message-1",
    })),
    updateStreamingReply: vi.fn(async () => undefined),
    finishStreamingReply: vi.fn(async () => undefined),
    sendTextReply: vi.fn(async () => ({ messageId: "message-text" })),
    sendFileReply: vi.fn(async () => ({
      messageId: "message-file",
      fileKey: "file-key",
    })),
  };
}

function userRuntimeMessage(tempId: string, turnId = "turn-1") {
  const clientUserMessageId = `client-${tempId}`;
  return {
    type: "user",
    tempId,
    uuid: clientUserMessageId,
    clientUserMessageId,
    turnId,
    codexTurnId: turnId,
    message: { content: "prompt" },
  };
}

function managedFileRuntimeMessage(sizeBytes: number) {
  const id = `ga_${"d".repeat(32)}`;
  const sha256 = `sha256:${createHash("sha256")
    .update(Buffer.from("%PDF-1.7\n"))
    .digest("hex")}`;
  return {
    type: "system",
    codexThreadItemLifecycle: "completed",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    codexThreadItem: {
      type: "fileChange",
      id: "file-1",
      status: "completed",
      changes: [{ path: "report.pdf", kind: { type: "add" } }],
    },
    codexGeneratedArtifacts: [
      {
        schemaVersion: 1,
        id,
        managedRef: "upload:123e4567-e89b-12d3-a456-426614174000",
        fileName: "report.pdf",
        kind: "document",
        mimeType: "application/pdf",
        sizeBytes,
        sha256,
        source: {
          provider: "codex",
          type: "file_change",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-1",
        },
        retention: {
          policy: "temporary",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        downloadUrl: `/api/projects/project-1/sessions/session-1/generated-artifact/${id}/${sha256.slice("sha256:".length)}/report.pdf`,
      },
    ],
  };
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function drainRuntimeEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
