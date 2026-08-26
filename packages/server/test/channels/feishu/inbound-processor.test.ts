import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FeishuAccountConfig,
  FeishuAccountConfigSchema,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuBindingStore } from "../../../src/channels/feishu/binding-store.js";
import {
  type FeishuInboundOutcome,
  FeishuInboundProcessor,
  formatFeishuAttachmentManifest,
} from "../../../src/channels/feishu/inbound-processor.js";
import { FeishuDurableInbox } from "../../../src/channels/feishu/inbox.js";
import type { FeishuMediaDownloader } from "../../../src/channels/feishu/media-downloader.js";
import type { FeishuAttachmentManifest } from "../../../src/channels/feishu/normalization/types.js";
import type { FeishuMessageApi } from "../../../src/channels/feishu/normalization/types.js";
import type {
  FeishuInteractionApi,
  FeishuOutboundApi,
} from "../../../src/channels/feishu/outbound.js";
import { FeishuReplyManager } from "../../../src/channels/feishu/reply-manager.js";
import { FeishuSkillSelectionManager } from "../../../src/channels/feishu/skill-selection-manager.js";
import { FeishuStatusRegistry } from "../../../src/channels/feishu/status.js";
import type { CodexNativeControlRequest } from "../../../src/sdk/providers/codex-controls.js";
import type { SessionCommandService } from "../../../src/services/SessionCommandService.js";

describe("FeishuInboundProcessor", () => {
  const dataDirs: string[] = [];
  const processors: FeishuInboundProcessor[] = [];
  const replyManagers: FeishuReplyManager[] = [];

  it("includes opaque extraction artifacts and bounded warnings in the prompt manifest", () => {
    const manifest: FeishuAttachmentManifest = {
      attachmentId: "attachment-1",
      source: { platform: "feishu", messageId: "om_fixture" },
      originalName: "report.pdf",
      sanitizedName: "attachment-1_report.pdf",
      declaredMime: "application/pdf",
      detectedMime: "application/pdf",
      kind: "pdf",
      sizeBytes: 123,
      sha256: "a".repeat(64),
      localPathRef: "upload:attachment-1",
      status: "extracted",
      extraction: {
        extractor: "yep-safe-attachment",
        version: "1",
        artifacts: [
          {
            kind: "text",
            pathRef: "upload:attachment-1:artifact:artifact-1",
            mime: "text/plain",
            sizeBytes: 42,
          },
        ],
        warnings: [
          "TRUNCATED: bounded\nwarning",
          "PATH: /opt/yep-fixtures/private/report.pdf",
        ],
        truncated: true,
      },
    };

    const output = formatFeishuAttachmentManifest([manifest]);

    expect(output).toContain("ref=upload:attachment-1");
    expect(output).toContain(
      "artifact: kind=text | mime=text/plain | bytes=42 | ref=upload:attachment-1:artifact:artifact-1",
    );
    expect(output).toContain("warning: TRUNCATED: bounded warning");
    expect(output).toContain("warning: PATH: /opt/yep-fixtures/private");
    expect(output).toContain("/opt/yep-fixtures/private");
  });

  afterEach(async () => {
    await Promise.all(
      processors.splice(0).map((processor) => processor.shutdown()),
    );
    await Promise.all(
      replyManagers.splice(0).map((manager) => manager.shutdown()),
    );
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("durably accepts before normalization and deduplicates a redelivery", async () => {
    const fixture = await createFixture(dataDirs);
    const names = deferred<ReadonlyMap<string, string>>();
    const api: FeishuMessageApi = {
      fetchMessageItems: vi.fn(async () => []),
      resolveUserNames: vi.fn(() => names.promise),
    };
    const outcomes: FeishuInboundOutcome[] = [];
    const statuses = new FeishuStatusRegistry();
    const processor = createProcessor(fixture, outcomes, undefined, statuses);
    processors.push(processor);
    const event = makeEvent("om_first", "Please inspect the repository");

    const accepted = await processor.accept({
      account: fixture.account,
      event,
      botIdentity: BOT,
      api,
    });

    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    expect(fixture.commands.start).not.toHaveBeenCalled();
    expect(fixture.commands.create).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
    expect(fixture.inbox.get(accepted.inboxKey ?? "")?.status).toBe("received");

    names.resolve(new Map([["ou_user", "User"]]));
    await eventually(() => expect(outcomes).toHaveLength(1));

    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    expect(fixture.commands.start).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: {
          createdBy: "channel",
          originChannel: "feishu",
          codexEventAccountId: fixture.account.id,
        },
        body: expect.objectContaining({
          model: undefined,
          reasoningEffort: undefined,
          codexMcpMode: "standard",
        }),
      }),
    );
    expect(fixture.commands.create).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
    expect(fixture.commands.start.mock.calls[0]?.[0]).toMatchObject({
      body: {
        message: expect.stringContaining("Please inspect the repository"),
        provider: "codex",
        tempId: expect.stringMatching(/^feishu-[a-f0-9]{32}$/),
      },
    });
    expect(fixture.commands.start.mock.calls[0]?.[0].body.message).toContain(
      "<feishu_context_manifest>\nmode: current",
    );
    expect(fixture.inbox.get(accepted.inboxKey ?? "")?.status).toBe(
      "completed",
    );
    expect(fixture.bindings.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        lastInboundMessageId: "om_first",
      }),
    ]);
    expect(statuses.get("team-bot")?.metrics).toMatchObject({
      messagesAccepted: 1,
      messagesDuplicateDropped: 0,
      messagesFailed: 0,
      scopeQueueDepth: 0,
    });
    expect(
      statuses.get("team-bot")?.metrics.lastNormalizationDurationMs,
    ).toBeGreaterThanOrEqual(0);

    await processor.accept({
      account: fixture.account,
      event,
      botIdentity: BOT,
      api,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    expect(fixture.commands.create).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
    expect(statuses.get("team-bot")?.metrics.messagesDuplicateDropped).toBe(1);
  });

  it("claims one normalize/dispatch owner for concurrent redelivery while received", async () => {
    const fixture = await createFixture(dataDirs);
    const names = deferred<ReadonlyMap<string, string>>();
    const api: FeishuMessageApi = {
      fetchMessageItems: vi.fn(async () => []),
      resolveUserNames: vi.fn(() => names.promise),
    };
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);
    const event = makeEvent("om_concurrent_redelivery", "Exactly once prompt");

    const accepted = await Promise.all([
      processor.accept({
        account: fixture.account,
        event,
        botIdentity: BOT,
        api,
      }),
      processor.accept({
        account: fixture.account,
        event,
        botIdentity: BOT,
        api,
      }),
    ]);

    expect(accepted.filter((result) => result.duplicate)).toHaveLength(1);
    await eventually(() =>
      expect(api.resolveUserNames).toHaveBeenCalledTimes(1),
    );
    names.resolve(new Map([["ou_user", "User"]]));
    await eventually(() => expect(outcomes).toHaveLength(1));

    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    const prompt = fixture.commands.start.mock.calls[0]?.[0].body.message;
    expect(prompt.match(/Exactly once prompt/g)).toHaveLength(1);
    expect(fixture.inbox.get(accepted[0]?.inboxKey ?? "")).toMatchObject({
      status: "completed",
      attempts: 1,
    });
  });

  it("batches merge-forward material with its adjacent instruction before slow expansion can reorder them", async () => {
    const fixture = await createFixture(dataDirs);
    const outcomes: FeishuInboundOutcome[] = [];
    const forwardedItems =
      deferred<Awaited<ReturnType<FeishuMessageApi["fetchMessageItems"]>>>();
    const api: FeishuMessageApi = {
      fetchMessageItems: vi.fn((messageId) => {
        expect(messageId).toBe("om_slow_material");
        return forwardedItems.promise;
      }),
    };
    const processor = new FeishuInboundProcessor({
      sessionCommandService:
        fixture.commands as unknown as SessionCommandService,
      bindingStore: fixture.bindings,
      inbox: fixture.inbox,
      debounceMs: 25,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    processors.push(processor);

    await Promise.all([
      processor.accept({
        account: fixture.account,
        event: makeMergeForwardEvent("om_slow_material"),
        botIdentity: BOT,
        api,
      }),
      processor.accept({
        account: fixture.account,
        event: makeEvent("om_fast_instruction", "Summarize that topic"),
        botIdentity: BOT,
      }),
    ]);

    await eventually(() =>
      expect(api.fetchMessageItems).toHaveBeenCalledOnce(),
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(fixture.commands.start).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();

    forwardedItems.resolve([
      {
        message_id: "om_forwarded_topic",
        upper_message_id: "om_slow_material",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "Forwarded topic material" }) },
        sender: { id: "ou_author" },
        create_time: "1000",
      },
    ]);
    await eventually(() => expect(outcomes).toHaveLength(1));

    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    expect(fixture.commands.send).not.toHaveBeenCalled();
    const prompt = fixture.commands.start.mock.calls[0]?.[0].body.message;
    expect(prompt).toContain("## 飞书消息 1/2");
    expect(prompt).toContain("## 飞书消息 2/2");
    expect(prompt.indexOf("Forwarded topic material")).toBeLessThan(
      prompt.indexOf("Summarize that topic"),
    );
  });

  it("keeps stop commands on the priority lane while merge-forward normalization is blocked", async () => {
    const fixture = await createFixture(dataDirs);
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey: `${fixture.account.id}:p2p:oc_chat`,
      accountId: fixture.account.id,
      chatId: "oc_chat",
      projectId: "project-real",
      projectPath: fixture.projectPath,
      sessionId: "session-active",
      provider: "codex",
      permissionMode: "default",
      createdAt: now,
      updatedAt: now,
    });
    const forwardedItems =
      deferred<Awaited<ReturnType<FeishuMessageApi["fetchMessageItems"]>>>();
    const api: FeishuMessageApi = {
      fetchMessageItems: vi.fn(() => forwardedItems.promise),
    };
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = new FeishuInboundProcessor({
      sessionCommandService:
        fixture.commands as unknown as SessionCommandService,
      bindingStore: fixture.bindings,
      inbox: fixture.inbox,
      debounceMs: 25,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    processors.push(processor);

    await processor.accept({
      account: fixture.account,
      event: makeMergeForwardEvent("om_blocked_forward"),
      botIdentity: BOT,
      api,
    });
    await eventually(() => expect(api.fetchMessageItems).toHaveBeenCalled());
    await processor.accept({
      account: fixture.account,
      event: makeEvent("om_priority_stop", "/stop"),
      botIdentity: BOT,
    });

    await eventually(() =>
      expect(fixture.commands.interrupt).toHaveBeenCalledWith("session-active"),
    );
    expect(fixture.commands.send).not.toHaveBeenCalled();

    forwardedItems.resolve([
      {
        message_id: "om_forwarded_after_stop",
        upper_message_id: "om_blocked_forward",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "Run after stop" }) },
        sender: { id: "ou_author" },
      },
    ]);
    await eventually(() => expect(outcomes).toHaveLength(2));
    expect(fixture.commands.send).toHaveBeenCalledTimes(1);
  });

  it("drops redelivery while the first provider dispatch is not terminal", async () => {
    const fixture = await createFixture(dataDirs);
    const outcomes: FeishuInboundOutcome[] = [];
    const dispatchAccepted = vi.fn(async () => undefined);
    const replyManager = {
      startTurn: vi.fn(async () => ({
        dispatchAccepted,
        dispatchFailed: vi.fn(async () => undefined),
        addTerminalCleanup: vi.fn(),
      })),
    } as unknown as FeishuReplyManager;
    const processor = createProcessor(fixture, outcomes, replyManager);
    processors.push(processor);
    const event = makeEvent(
      "om_dispatched_redelivery",
      "Keep one live provider turn",
    );

    const first = await processor.accept({
      account: fixture.account,
      event,
      botIdentity: BOT,
    });
    await eventually(() =>
      expect(fixture.inbox.get(first.inboxKey ?? "")).toMatchObject({
        status: "dispatched",
        attempts: 1,
      }),
    );

    const duplicate = await processor.accept({
      account: fixture.account,
      event,
      botIdentity: BOT,
    });
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    expect(replyManager.startTurn).toHaveBeenCalledTimes(1);
    expect(dispatchAccepted).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
    expect(fixture.inbox.get(first.inboxKey ?? "")).toMatchObject({
      status: "dispatched",
      attempts: 1,
    });
  });

  it("fails closed when the configured project escapes allowed roots", async () => {
    const fixture = await createFixture(dataDirs);
    const outside = await mkdtemp(join(tmpdir(), "yep-feishu-outside-"));
    dataDirs.push(outside);
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(
      {
        ...fixture,
        account: makeAccount({ defaultProjectPath: outside }),
      },
      outcomes,
    );
    processors.push(processor);
    const accepted = await processor.accept({
      account: makeAccount({ defaultProjectPath: outside }),
      event: makeEvent("om_outside", "Run this"),
      botIdentity: BOT,
    });

    await eventually(() =>
      expect(fixture.inbox.get(accepted.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "PROJECT_NOT_ALLOWED",
      }),
    );
    expect(fixture.commands.start).not.toHaveBeenCalled();
    expect(fixture.commands.create).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(0);
  });

  it("fails closed when a thread-aware group root cannot be classified", async () => {
    const fixture = await createFixture(dataDirs);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
      allowedChats: ["oc_chat"],
      requireMentionInGroup: false,
      groupSessionMode: "thread-when-available",
    });
    const processor = createProcessor({ ...fixture, account }, []);
    processors.push(processor);
    const event = makeEvent("om_ambiguous_root", "Keep this scoped") as {
      message: Record<string, unknown>;
    };
    event.message.chat_type = "group";
    event.message.root_id = "om_possible_topic_root";
    const getChatMode = vi.fn(async () => {
      throw new Error("synthetic metadata failure");
    });

    const accepted = await processor.accept({
      account,
      event,
      botIdentity: BOT,
      api: { fetchMessageItems: vi.fn(async () => []), getChatMode },
    });

    await eventually(() =>
      expect(fixture.inbox.get(accepted.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "NORMALIZATION_FAILED",
      }),
    );
    expect(getChatMode).toHaveBeenCalledWith("oc_chat");
    expect(fixture.commands.start).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
  });

  it("applies account model, reasoning, and MCP defaults to new bindings", async () => {
    const fixture = await createFixture(dataDirs);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
      defaultModel: "gpt-5.6-codex",
      defaultReasoningEffort: "high",
      defaultCodexMcpMode: "clear",
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    await processor.accept({
      account,
      event: makeEvent("om_defaults", "Use configured defaults"),
      botIdentity: BOT,
    });
    await eventually(() => expect(outcomes).toHaveLength(1));

    expect(fixture.commands.start).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          provider: "codex",
          mode: "default",
          model: "gpt-5.6-codex",
          reasoningEffort: "high",
          codexMcpMode: "clear",
        }),
      }),
    );
    expect(fixture.bindings.list()[0]).toMatchObject({
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      codexMcpMode: "clear",
    });
    expect(fixture.commands.create).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
  });

  it("does not persist a fresh binding when atomic start is not accepted", async () => {
    const fixture = await createFixture(dataDirs);
    const statuses = new FeishuStatusRegistry();
    const replyManager = new FeishuReplyManager({
      sessionCommandService:
        fixture.commands as unknown as SessionCommandService,
      inbox: fixture.inbox,
      statusRegistry: statuses,
      controllerOptions: { throttleMs: 0 },
    });
    replyManagers.push(replyManager);
    fixture.commands.start.mockImplementationOnce(
      async () =>
        ({
          ok: false as const,
          status: 503 as const,
          body: { error: "Queue is full" },
        }) as never,
    );
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(
      fixture,
      outcomes,
      replyManager,
      statuses,
    );
    processors.push(processor);

    const accepted = await processor.accept({
      account: fixture.account,
      event: makeEvent("om_start_failed", "Run atomically"),
      botIdentity: BOT,
    });

    await eventually(() =>
      expect(fixture.inbox.get(accepted.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "SESSION_COMMAND_FAILED",
      }),
    );
    expect(fixture.bindings.list()).toHaveLength(0);
    expect(fixture.commands.create).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(0);
    expect(statuses.get("team-bot")?.metrics).toMatchObject({
      messagesAccepted: 1,
      messagesFailed: 1,
    });
  });

  it("keeps fresh-turn attachments while binding only the real started session", async () => {
    const fixture = await createFixture(dataDirs);
    const attachment = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      originalName: "fixture.png",
      name: "123e4567-e89b-12d3-a456-426614174000_fixture.png",
      path: join(fixture.dataDir, "staged", "fixture.png"),
      size: 7,
      mimeType: "image/png",
    };
    const downloadAll = vi.fn(async () => ({
      attachments: [attachment],
      manifests: [],
      failures: [],
    }));
    const releaseTaskAudioStaging = vi.fn(async () => undefined);
    const addTerminalCleanup = vi.fn();
    const replyManager = {
      startTurn: vi.fn(async () => ({
        dispatchAccepted: vi.fn(async () => undefined),
        dispatchFailed: vi.fn(async () => undefined),
        addTerminalCleanup,
      })),
    } as unknown as FeishuReplyManager;
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = new FeishuInboundProcessor({
      sessionCommandService:
        fixture.commands as unknown as SessionCommandService,
      bindingStore: fixture.bindings,
      inbox: fixture.inbox,
      mediaDownloader: {
        downloadAll,
        releaseTaskAudioStaging,
        stopRetentionCleanup: vi.fn(),
      } as unknown as FeishuMediaDownloader,
      replyManager,
      debounceMs: 0,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    processors.push(processor);
    const event = makeEvent("om_fresh_attachment", "") as {
      message: { message_type: string; content: string };
    };
    event.message.message_type = "image";
    event.message.content = JSON.stringify({ image_key: "img_fixture" });
    const api: FeishuMessageApi = {
      fetchMessageItems: vi.fn(async () => []),
      downloadMessageResource: vi.fn(),
    };

    const accepted = await processor.accept({
      account: fixture.account,
      event,
      botIdentity: BOT,
      api,
    });

    await eventually(() => expect(outcomes).toHaveLength(1));
    const record = fixture.inbox.get(accepted.inboxKey ?? "");
    expect(downloadAll).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: expect.any(String),
        sessionId: record?.tempId,
        taskId: record?.tempId,
      }),
    );
    expect(fixture.commands.start).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ attachments: [attachment] }),
      }),
    );
    expect(fixture.bindings.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
      }),
    ]);
    expect(fixture.bindings.list()[0]?.sessionId).not.toBe(record?.tempId);
    expect(addTerminalCleanup).toHaveBeenCalledTimes(1);
    const cleanup = addTerminalCleanup.mock.calls[0]?.[0];
    await cleanup?.();
    expect(releaseTaskAudioStaging).toHaveBeenCalledWith(record?.tempId);
  });

  it("persists the real binding before exposing a dispatched inbox record", async () => {
    const fixture = await createFixture(dataDirs);
    const scopeKey = `${fixture.account.id}:p2p:oc_chat`;
    const originalMarkDispatched = fixture.inbox.markDispatched.bind(
      fixture.inbox,
    );
    const markDispatched = vi
      .spyOn(fixture.inbox, "markDispatched")
      .mockImplementation(async (key, updates) => {
        expect(fixture.bindings.get(scopeKey)).toMatchObject({
          sessionId: "session-1",
          lastInboundMessageId: "om_binding_first",
        });
        return originalMarkDispatched(key, updates);
      });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);

    await processor.accept({
      account: fixture.account,
      event: makeEvent("om_binding_first", "Persist before dispatch marker"),
      botIdentity: BOT,
    });

    await eventually(() => expect(outcomes).toHaveLength(1));
    expect(markDispatched).toHaveBeenCalledTimes(1);
  });

  it("recovers received work and fails closed an unobservable dispatched turn", async () => {
    const fixture = await createFixture(dataDirs);
    const received = await fixture.inbox.receive({
      accountId: fixture.account.id,
      eventId: "evt_recover",
      eventType: "im.message.receive_v1",
      messageId: "om_recover",
    });
    const dispatched = await fixture.inbox.receive({
      accountId: fixture.account.id,
      eventId: "evt_dispatched",
      eventType: "im.message.receive_v1",
      messageId: "om_dispatched",
    });
    await fixture.inbox.beginDispatch(dispatched.record.key);
    await fixture.inbox.markDispatched(dispatched.record.key, {
      sessionId: "session-prior",
    });

    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);
    const api: FeishuMessageApi = {
      fetchMessageItems: vi.fn(async () => []),
      fetchMessageEvent: vi.fn(async () =>
        makeEvent("om_recover", "Recovered task"),
      ),
    };
    await processor.recover(() => ({
      account: fixture.account,
      botIdentity: BOT,
      api,
    }));

    expect(fixture.inbox.get(dispatched.record.key)).toMatchObject({
      status: "failed",
      lastErrorCode: "RECOVERY_FAILED",
    });
    await eventually(() => expect(outcomes).toHaveLength(1));
    expect(api.fetchMessageEvent).toHaveBeenCalledWith("om_recover");
    expect(fixture.inbox.get(received.record.key)?.status).toBe("completed");
    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    expect(fixture.commands.send).not.toHaveBeenCalled();
  });

  it("serializes recovered rows without merging restart-time neighbors into one request", async () => {
    const fixture = await createFixture(dataDirs);
    for (const messageId of ["om_recover_first", "om_recover_second"]) {
      await fixture.inbox.receive({
        accountId: fixture.account.id,
        eventId: `evt_${messageId}`,
        eventType: "im.message.receive_v1",
        messageId,
      });
    }
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);
    const api: FeishuMessageApi = {
      fetchMessageItems: vi.fn(async () => []),
      fetchMessageEvent: vi.fn(async (messageId) =>
        makeEvent(messageId, `Recovered ${messageId}`),
      ),
    };

    await processor.recover(() => ({
      account: fixture.account,
      botIdentity: BOT,
      api,
    }));
    await eventually(() => expect(outcomes).toHaveLength(2));

    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    expect(fixture.commands.send).toHaveBeenCalledTimes(1);
    expect(fixture.commands.send).toHaveBeenCalledWith(
      expect.objectContaining({ allowSteer: false }),
    );
    expect(fixture.commands.start.mock.calls[0]?.[0].body.message).toContain(
      "Recovered om_recover_first",
    );
    expect(fixture.commands.send.mock.calls[0]?.[0].body.message).toContain(
      "Recovered om_recover_second",
    );
  });

  it("converges a crash after binding persistence but before the dispatch marker", async () => {
    const fixture = await createFixture(dataDirs);
    const scopeKey = `${fixture.account.id}:p2p:oc_chat`;
    const received = await fixture.inbox.receive({
      accountId: fixture.account.id,
      eventId: "evt_crash_window",
      eventType: "im.message.receive_v1",
      messageId: "om_crash_window",
      scopeKey,
    });
    await fixture.inbox.beginDispatch(received.record.key, { scopeKey });
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey,
      accountId: fixture.account.id,
      chatId: "oc_chat",
      projectId: "project-real",
      projectPath: fixture.projectPath,
      sessionId: "session-real",
      provider: "codex",
      permissionMode: "default",
      createdAt: now,
      updatedAt: now,
      lastInboundMessageId: "om_crash_window",
      lastInboundSenderOpenId: "ou_user",
    });
    const restoreTurn = vi.fn(async () => true);
    const replyManager = {
      restoreTurn,
    } as unknown as FeishuReplyManager;
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes, replyManager);
    processors.push(processor);

    await processor.recover(() => ({
      account: fixture.account,
      botIdentity: BOT,
      api: makeOutboundApi(),
    }));

    expect(fixture.inbox.get(received.record.key)).toMatchObject({
      status: "dispatched",
      sessionId: "session-real",
    });
    expect(restoreTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-real",
        tempId: received.record.tempId,
        inboxKeys: [received.record.key],
      }),
    );
    expect(fixture.commands.start).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
  });

  it.each([
    ["before the fresh runtime accepts the start", false],
    ["after the fresh runtime accepts the start", true],
  ] as const)(
    "fails closed %s when no durable binding receipt exists",
    async (_window, runtimeAlreadyAccepted) => {
      const fixture = await createFixture(dataDirs);
      const scopeKey = `${fixture.account.id}:p2p:oc_chat`;
      const received = await fixture.inbox.receive({
        accountId: fixture.account.id,
        eventId: "evt_uncertain_fresh_start",
        eventType: "im.message.receive_v1",
        messageId: "om_uncertain_fresh_start",
        scopeKey,
      });
      await fixture.inbox.beginDispatch(received.record.key, { scopeKey });
      if (runtimeAlreadyAccepted) {
        await fixture.commands.start({
          body: { message: "already accepted by the external runtime" },
        } as never);
      }
      const fetchMessageEvent = vi.fn(async () =>
        makeEvent("om_uncertain_fresh_start", "must not be dispatched twice"),
      );
      const outcomes: FeishuInboundOutcome[] = [];
      const processor = createProcessor(fixture, outcomes);
      processors.push(processor);

      await processor.recover(() => ({
        account: fixture.account,
        botIdentity: BOT,
        api: {
          fetchMessageItems: vi.fn(async () => []),
          fetchMessageEvent,
        },
      }));

      expect(fixture.inbox.get(received.record.key)).toMatchObject({
        status: "failed",
        lastErrorCode: "RECOVERY_FAILED",
        attempts: 1,
      });
      expect(fetchMessageEvent).not.toHaveBeenCalled();
      expect(fixture.commands.start).toHaveBeenCalledTimes(
        runtimeAlreadyAccepted ? 1 : 0,
      );
      expect(fixture.commands.create).not.toHaveBeenCalled();
      expect(fixture.commands.send).not.toHaveBeenCalled();
      expect(outcomes).toHaveLength(0);
    },
  );

  it("keeps accepted work dispatched until the matching runtime turn finishes", async () => {
    const fixture = await createFixture(dataDirs);
    const replyManager = new FeishuReplyManager({
      sessionCommandService:
        fixture.commands as unknown as SessionCommandService,
      inbox: fixture.inbox,
      controllerOptions: { throttleMs: 0 },
    });
    replyManagers.push(replyManager);
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes, replyManager);
    processors.push(processor);
    const api = makeOutboundApi();

    const accepted = await processor.accept({
      account: fixture.account,
      event: makeEvent("om_streaming", "Stream the answer"),
      botIdentity: BOT,
      api,
    });

    await eventually(() => expect(outcomes).toHaveLength(1));
    const inboxKey = accepted.inboxKey ?? "";
    const record = fixture.inbox.get(inboxKey);
    expect(record).toMatchObject({
      status: "dispatched",
      sessionId: "session-1",
    });
    await eventually(() =>
      expect(api.createStreamingReply).toHaveBeenCalledTimes(1),
    );

    fixture.commands.emit("session-1", "message", {
      type: "user",
      tempId: record?.tempId,
      uuid: "client-streaming-turn",
      clientUserMessageId: "client-streaming-turn",
      turnId: "turn-streaming",
      codexTurnId: "turn-streaming",
      message: { content: "Stream the answer" },
    });
    fixture.commands.emit("session-1", "message", {
      type: "assistant",
      message: { content: "Runtime answer" },
    });
    fixture.commands.emit("session-1", "status", { state: "idle" });

    await eventually(() =>
      expect(fixture.inbox.get(inboxKey)?.status).toBe("completed"),
    );
    expect(api.finishStreamingReply).toHaveBeenCalledTimes(1);
  });

  it("passes an accepted replacement process generation to the reply manager", async () => {
    const fixture = await createFixture(dataDirs);
    fixture.commands.start.mockResolvedValueOnce({
      ok: true as const,
      status: 200 as const,
      body: {
        sessionId: "session-1",
        restarted: true,
        processId: "process-replacement",
      },
    });
    const dispatchAccepted = vi.fn(async () => undefined);
    const dispatchFailed = vi.fn(async () => undefined);
    const replyManager = {
      startTurn: vi.fn(async () => ({ dispatchAccepted, dispatchFailed })),
    } as unknown as FeishuReplyManager;
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes, replyManager);
    processors.push(processor);

    await processor.accept({
      account: fixture.account,
      event: makeEvent("om_restarted", "Use replacement runtime"),
      botIdentity: BOT,
      api: makeOutboundApi(),
    });

    await eventually(() => expect(outcomes).toHaveLength(1));
    expect(dispatchAccepted).toHaveBeenCalledWith("session-1", {
      processId: "process-replacement",
      restarted: true,
    });
    expect(dispatchFailed).not.toHaveBeenCalled();
  });

  it("isolates identical chats and Codex rollout keys across accounts", async () => {
    const fixture = await createFixture(dataDirs);
    const second = makeAccount({
      id: "second-bot",
      name: "Second Bot",
      appId: "cli_fedcba9876543210",
      secretRef: "store:second-bot",
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);

    await Promise.all([
      processor.accept({
        account: fixture.account,
        event: makeEvent("om_account_a", "Account A"),
        botIdentity: BOT,
      }),
      processor.accept({
        account: second,
        event: makeEvent("om_account_b", "Account B"),
        botIdentity: BOT,
      }),
    ]);
    await eventually(() => expect(outcomes).toHaveLength(2));

    expect(fixture.bindings.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "team-bot",
          scopeKey: "team-bot:p2p:oc_chat",
        }),
        expect.objectContaining({
          accountId: "second-bot",
          scopeKey: "second-bot:p2p:oc_chat",
        }),
      ]),
    );
    expect(
      fixture.commands.start.mock.calls.map(
        (call) => call[0].origin?.codexEventAccountId,
      ),
    ).toEqual(expect.arrayContaining(["team-bot", "second-bot"]));
  });

  it("uses the existing binding for follow-up turns", async () => {
    const fixture = await createFixture(dataDirs);
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);

    await processor.accept({
      account: fixture.account,
      event: makeEvent("om_initial", "Initial turn"),
      botIdentity: BOT,
    });
    await eventually(() => expect(outcomes).toHaveLength(1));
    await processor.accept({
      account: fixture.account,
      event: makeEvent("om_follow_up", "Follow-up turn"),
      botIdentity: BOT,
    });
    await eventually(() => expect(outcomes).toHaveLength(2));

    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
    expect(fixture.commands.send).toHaveBeenCalledTimes(1);
    expect(fixture.commands.send).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        origin: {
          createdBy: "channel",
          originChannel: "feishu",
          codexEventAccountId: "team-bot",
        },
        requireImmediate: true,
        allowSteer: false,
      }),
    );
    expect(fixture.bindings.list()[0]).toMatchObject({
      sessionId: "session-1",
      lastInboundMessageId: "om_follow_up",
    });
  });

  it("handles status, stop, reset, new and admin project commands", async () => {
    const fixture = await createFixture(dataDirs);
    const secondProject = join(fixture.allowedRoot, "second-project");
    await mkdir(secondProject);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
      allowedUsers: ["ou_user"],
      adminUsers: ["ou_admin"],
    });
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey: `${account.id}:p2p:oc_chat`,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-old",
      provider: "codex",
      createdAt: now,
      updatedAt: now,
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    await acceptCommand(processor, account, "om_status", "/status", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({
      command: "status",
      sessionId: "session-old",
    });

    await acceptCommand(processor, account, "om_stop", "/stop", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(2));
    expect(fixture.commands.interrupt).toHaveBeenCalledWith("session-old");

    await acceptCommand(processor, account, "om_reset", "/reset", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(3));
    expect(fixture.bindings.list()).toHaveLength(0);

    await acceptCommand(processor, account, "om_new", "/new", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(4));
    expect(fixture.bindings.list()[0]?.sessionId).toBe("session-1");
    expect(fixture.commands.create.mock.calls[0]?.[0]).toMatchObject({
      requireImmediate: true,
    });

    await acceptCommand(
      processor,
      account,
      "om_project",
      `/project ${secondProject}`,
      "ou_admin",
    );
    await eventually(() => expect(outcomes).toHaveLength(5));
    expect(fixture.bindings.list()[0]).toMatchObject({
      projectPath: await realpath(secondProject),
      sessionId: "session-2",
    });
    expect(fixture.commands.send).not.toHaveBeenCalled();
  });

  it("releases the previous session before /new and replaces its binding", async () => {
    const fixture = await createFixture(dataDirs);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
      allowedUsers: ["ou_user"],
    });
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey: `${account.id}:p2p:oc_chat`,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-old",
      provider: "codex",
      createdAt: now,
      updatedAt: now,
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    await acceptCommand(processor, account, "om_new_owned", "/new", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(1));

    expect(fixture.commands.releaseSession).toHaveBeenCalledTimes(1);
    expect(fixture.commands.releaseSession).toHaveBeenCalledWith("session-old");
    expect(fixture.commands.interrupt).not.toHaveBeenCalled();
    expect(fixture.commands.create).toHaveBeenCalledWith(
      expect.objectContaining({ requireImmediate: true }),
    );
    expect(fixture.bindings.list()).toEqual([
      expect.objectContaining({ sessionId: "session-1" }),
    ]);
    expect(outcomes[0]).toMatchObject({
      command: "new",
      sessionId: "session-1",
    });
  });

  it("keeps the previous binding when /new cannot release its owner", async () => {
    const fixture = await createFixture(dataDirs);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
      allowedUsers: ["ou_user"],
    });
    const now = new Date().toISOString();
    const scopeKey = `${account.id}:p2p:oc_chat`;
    await fixture.bindings.upsert({
      version: 1,
      scopeKey,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-old",
      provider: "codex",
      createdAt: now,
      updatedAt: now,
    });
    fixture.commands.releaseSession.mockResolvedValueOnce({
      ok: false as const,
      status: 409 as const,
      body: {
        error: "Session process could not be released",
        code: "session_release_failed",
      },
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    const accepted = await processor.accept({
      account,
      event: makeEvent("om_new_release_failed", "/new", "ou_user"),
      botIdentity: BOT,
    });
    await eventually(() =>
      expect(fixture.inbox.get(accepted.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "SESSION_COMMAND_FAILED",
      }),
    );

    expect(fixture.commands.create).not.toHaveBeenCalled();
    expect(fixture.bindings.get(scopeKey)?.sessionId).toBe("session-old");
    expect(outcomes).toHaveLength(0);
  });

  it("leaves no stale binding or queued create when /new immediate admission fails", async () => {
    const fixture = await createFixture(dataDirs);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
      allowedUsers: ["ou_user"],
    });
    const now = new Date().toISOString();
    const scopeKey = `${account.id}:p2p:oc_chat`;
    await fixture.bindings.upsert({
      version: 1,
      scopeKey,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-old",
      provider: "codex",
      createdAt: now,
      updatedAt: now,
    });
    fixture.commands.create.mockResolvedValueOnce({
      ok: false as const,
      status: 503 as const,
      body: {
        error: "Session could not start immediately",
        code: "immediate_start_unavailable",
      },
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    const accepted = await processor.accept({
      account,
      event: makeEvent("om_new_capacity_failed", "/new", "ou_user"),
      botIdentity: BOT,
    });
    await eventually(() =>
      expect(fixture.inbox.get(accepted.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "SESSION_COMMAND_FAILED",
      }),
    );

    expect(fixture.commands.releaseSession).toHaveBeenCalledWith("session-old");
    expect(fixture.commands.create).toHaveBeenCalledWith(
      expect.objectContaining({ requireImmediate: true }),
    );
    expect(fixture.bindings.get(scopeKey)).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  it("releases the newly created session when /new cannot persist its binding", async () => {
    const fixture = await createFixture(dataDirs);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.allowedRoot],
      allowedUsers: ["ou_user"],
    });
    const scopeKey = `${account.id}:p2p:oc_chat`;
    vi.spyOn(fixture.bindings, "upsert").mockRejectedValueOnce(
      new Error("binding write failed"),
    );
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    const accepted = await processor.accept({
      account,
      event: makeEvent("om_new_binding_failed", "/new", "ou_user"),
      botIdentity: BOT,
    });
    await eventually(() =>
      expect(fixture.inbox.get(accepted.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "DISPATCH_FAILED",
      }),
    );

    expect(fixture.commands.create).toHaveBeenCalledWith(
      expect.objectContaining({ requireImmediate: true }),
    );
    expect(fixture.commands.releaseSession).toHaveBeenCalledWith("session-1");
    expect(fixture.bindings.get(scopeKey)).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  it("handles help, configured project selection, mode and doctor commands", async () => {
    const fixture = await createFixture(dataDirs);
    const secondProject = join(fixture.allowedRoot, "second-project");
    await mkdir(secondProject);
    const account = makeAccount({
      defaultProjectPath: fixture.projectPath,
      allowedWorkspaceRoots: [fixture.projectPath, secondProject],
      allowedUsers: ["ou_user"],
      adminUsers: ["ou_admin"],
    });
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey: `${account.id}:p2p:oc_chat`,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-old",
      provider: "codex",
      permissionMode: "default",
      createdAt: now,
      updatedAt: now,
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    await acceptCommand(processor, account, "om_help", "/help", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]?.text).toContain("/project list");

    await acceptCommand(
      processor,
      account,
      "om_projects",
      "/project list",
      "ou_user",
    );
    await eventually(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]?.text).toContain("second-project");

    await acceptCommand(
      processor,
      account,
      "om_project_use",
      "/project use second-project",
      "ou_user",
    );
    await eventually(() => expect(outcomes).toHaveLength(3));
    expect(fixture.bindings.list()[0]).toMatchObject({
      projectPath: await realpath(secondProject),
      sessionId: "session-1",
    });
    expect(fixture.commands.releaseSession).toHaveBeenCalledWith("session-old");

    await acceptCommand(processor, account, "om_mode", "/mode plan", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(4));
    expect(fixture.commands.setPermissionMode).toHaveBeenCalledWith(
      "session-1",
      "plan",
    );
    expect(fixture.bindings.list()[0]?.permissionMode).toBe("plan");

    await acceptCommand(processor, account, "om_doctor", "/doctor", "ou_user");
    await eventually(() => expect(outcomes).toHaveLength(5));
    expect(outcomes[4]?.text).toContain("Yep Runtime：可用");
    expect(outcomes[4]?.text).not.toContain("secret");
  });

  it("dispatches bounded, plaintext stable /codex controls", async () => {
    const fixture = await createFixture(dataDirs);
    const account = fixture.account;
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey: `${account.id}:p2p:oc_chat`,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-codex",
      provider: "codex",
      permissionMode: "default",
      createdAt: now,
      updatedAt: now,
    });
    fixture.commands.executeCodexControl.mockImplementation(async (input) => {
      switch (input.request.control) {
        case "skills/list":
          return {
            ok: true as const,
            status: 200 as const,
            body: {
              control: "skills/list",
              data: {
                data: [
                  {
                    cwd: "/opt/yep-fixtures/private-repository",
                    skills: Array.from({ length: 24 }, (_, index) => ({
                      name: `skill-${index + 1}`,
                      description:
                        index === 0
                          ? "Reads /opt/yep-fixtures/private/SKILL.md before work"
                          : "A".repeat(500),
                      path: `/opt/yep-fixtures/user-a/skills/skill-${index + 1}/SKILL.md`,
                    })),
                    errors: [
                      {
                        path: "/opt/yep-fixtures/user-a/skills/broken/SKILL.md",
                        message: "secret parser error",
                      },
                    ],
                  },
                ],
              },
            },
          };
        case "thread/goal/get":
        case "thread/goal/set":
          return {
            ok: true as const,
            status: 200 as const,
            body: {
              control: input.request.control,
              data: {
                goal: {
                  threadId: "private-thread-id",
                  objective:
                    input.request.control === "thread/goal/set"
                      ? input.request.objective
                      : "Ship safely",
                  status: "active",
                  tokenBudget: 10_000,
                  tokensUsed: 125,
                },
              },
            },
          };
        case "thread/goal/clear":
          return {
            ok: true as const,
            status: 200 as const,
            body: {
              control: input.request.control,
              data: { cleared: true },
            },
          };
        case "review/start":
        case "thread/compact/start":
          return {
            ok: true as const,
            status: 200 as const,
            body: { control: input.request.control, data: {} },
          };
        default:
          throw new Error(`Unexpected control: ${input.request.control}`);
      }
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor({ ...fixture, account }, outcomes);
    processors.push(processor);

    const commands = [
      "/codex skills",
      "/codex compact",
      "/codex goal",
      "/codex goal set Finish the parity work",
      "/codex goal clear",
      "/codex review",
    ];
    for (const [index, command] of commands.entries()) {
      await acceptCommand(
        processor,
        account,
        `om_codex_${index}`,
        command,
        "ou_user",
      );
      await eventually(() => expect(outcomes).toHaveLength(index + 1));
    }

    expect(fixture.commands.executeCodexControl.mock.calls).toEqual([
      [
        {
          sessionId: "session-codex",
          request: { control: "skills/list" },
        },
      ],
      [
        {
          sessionId: "session-codex",
          request: { control: "thread/compact/start" },
        },
      ],
      [
        {
          sessionId: "session-codex",
          request: { control: "thread/goal/get" },
        },
      ],
      [
        {
          sessionId: "session-codex",
          request: {
            control: "thread/goal/set",
            objective: "Finish the parity work",
          },
        },
      ],
      [
        {
          sessionId: "session-codex",
          request: { control: "thread/goal/clear" },
        },
      ],
      [
        {
          sessionId: "session-codex",
          request: {
            control: "review/start",
            target: { type: "uncommittedChanges" },
            delivery: "inline",
          },
        },
      ],
    ]);
    expect(outcomes[0]?.text).toContain("skill-1");
    expect(outcomes[0]?.text).toContain("另有 12 项未显示");
    expect(outcomes[0]?.text).toContain("/opt/yep-fixtures/");
    expect(outcomes[0]?.text).not.toContain("secret parser error");
    expect(Array.from(outcomes[0]?.text ?? "").length).toBeLessThanOrEqual(
      3_500,
    );
    expect(outcomes[3]?.text).toContain("Finish the parity work");
    expect(outcomes[3]?.text).not.toContain("private-thread-id");
    expect(outcomes[5]?.text).toBe("已启动对未提交变更的 inline review。");
  });

  it("blocks unsafe or unknown /codex commands without treating them as prompts", async () => {
    const fixture = await createFixture(dataDirs);
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);
    const commands = [
      "/codex skills",
      "/codex shell rm -rf /",
      "/codex ps",
      "/codex stop",
      "/codex clean",
      "/codex unknown-subcommand",
      "/codex goal set",
      "/codex goal set token=fixture-sensitive-value",
    ];

    for (const [index, command] of commands.entries()) {
      await acceptCommand(
        processor,
        fixture.account,
        `om_codex_blocked_${index}`,
        command,
        "ou_user",
      );
      await eventually(() => expect(outcomes).toHaveLength(index + 1));
    }

    expect(outcomes[0]?.text).toContain("当前没有 Codex 会话绑定");
    expect(outcomes[1]?.text).toContain("已阻止 /codex shell");
    expect(outcomes[2]?.text).toContain("experimental API");
    expect(outcomes[3]?.text).toContain("顶层 /stop");
    expect(outcomes[5]?.text).toContain("未知或未开放");
    expect(outcomes[6]?.text).toBe("用法：/codex goal set <objective>");
    expect(outcomes[7]?.text).toContain("当前没有 Codex 会话绑定");
    expect(outcomes.every((outcome) => outcome.command === "codex")).toBe(true);
    expect(fixture.commands.executeCodexControl).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
    expect(fixture.commands.interrupt).not.toHaveBeenCalled();
  });

  it("maps typed provider failures with original diagnostic text", async () => {
    const fixture = await createFixture(dataDirs);
    const account = fixture.account;
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey: `${account.id}:p2p:oc_chat`,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-codex",
      provider: "codex",
      permissionMode: "default",
      createdAt: now,
      updatedAt: now,
    });
    fixture.commands.executeCodexControl.mockResolvedValue({
      ok: false as const,
      status: 502 as const,
      body: {
        error: "synthetic provider error at /opt/yep-fixtures/private",
        code: "provider_error",
        control: "thread/compact/start",
        retryable: true,
      },
    });
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(fixture, outcomes);
    processors.push(processor);

    await acceptCommand(
      processor,
      account,
      "om_codex_provider_error",
      "/codex compact",
      "ou_user",
    );
    await eventually(() => expect(outcomes).toHaveLength(1));

    expect(outcomes[0]?.text).toBe(
      "synthetic provider error at /opt/yep-fixtures/private",
    );
    expect(outcomes[0]?.text).not.toContain("secret");
    expect(outcomes[0]?.text).toContain("/opt/yep-fixtures/");
  });

  it("retains a selected Skill until an existing-binding turn has a concrete process", async () => {
    const fixture = await createFixture(dataDirs);
    const account = fixture.account;
    const scopeKey = `${account.id}:p2p:oc_chat`;
    const now = new Date().toISOString();
    await fixture.bindings.upsert({
      version: 1,
      scopeKey,
      accountId: account.id,
      chatId: "oc_chat",
      projectId: "existing-project",
      projectPath: fixture.projectPath,
      sessionId: "session-codex",
      provider: "codex",
      permissionMode: "default",
      createdAt: now,
      updatedAt: now,
    });
    fixture.commands.executeCodexControl.mockResolvedValue({
      ok: true as const,
      status: 200 as const,
      body: {
        control: "skills/list",
        data: {
          data: [
            {
              cwd: fixture.projectPath,
              skills: [
                {
                  name: "safe-skill",
                  description: "A safe test skill",
                  path: "/opt/yep-fixtures/user-a/skills/safe-skill/SKILL.md",
                  enabled: true,
                },
              ],
              errors: [],
            },
          ],
        },
      },
    });
    let tokenCounter = 0;
    const skillManager = new FeishuSkillSelectionManager({
      getBinding: (key) => fixture.bindings.get(key),
      createToken: () => {
        tokenCounter += 1;
        return tokenCounter.toString(16).padStart(32, "0");
      },
    });
    const api = makeSkillApi();
    const outcomes: FeishuInboundOutcome[] = [];
    const processor = createProcessor(
      fixture,
      outcomes,
      undefined,
      undefined,
      skillManager,
    );
    processors.push(processor);

    await acceptCommand(
      processor,
      account,
      "om_skill_picker",
      "/codex skills",
      "ou_user",
      api,
    );
    await eventually(() =>
      expect(api.createInputCard).toHaveBeenCalledTimes(1),
    );
    const token = findSkillActionToken(api.createInputCard.mock.calls[0]?.[1]);
    await expect(
      skillManager.acceptCardAction({
        accountId: account.id,
        event: {
          messageId: "skill-card-message-1",
          chatId: "oc_chat",
          operatorOpenId: "ou_user",
          actionTag: "button",
          value: { token },
        },
        api,
        adminUsers: account.adminUsers,
      }),
    ).resolves.toBe("claimed");

    fixture.commands.send.mockResolvedValueOnce({
      ok: false as const,
      status: 503 as const,
      body: { error: "Queue is full" },
    });
    await processor.accept({
      account,
      event: makeEvent("om_skill_failed", "First attempt", "ou_user"),
      botIdentity: BOT,
      api,
    });
    await eventually(() =>
      expect(fixture.commands.send).toHaveBeenCalledTimes(1),
    );
    expect(fixture.commands.send.mock.calls[0]?.[0].body.codexInputs).toEqual([
      {
        type: "skill",
        name: "safe-skill",
        path: "/opt/yep-fixtures/user-a/skills/safe-skill/SKILL.md",
      },
    ]);
    expect(
      skillManager.peekForNextMessage({
        accountId: account.id,
        scopeKey,
        sessionId: "session-codex",
        requesterOpenId: "ou_user",
      }),
    ).toBeDefined();

    fixture.commands.send.mockResolvedValueOnce({
      ok: true as const,
      status: 202 as const,
      body: { queued: true },
    });
    const queuedAttempt = await processor.accept({
      account,
      event: makeEvent("om_skill_retry", "Retry", "ou_user"),
      botIdentity: BOT,
      api,
    });
    await eventually(() =>
      expect(fixture.commands.send).toHaveBeenCalledTimes(2),
    );
    expect(fixture.commands.send.mock.calls[1]?.[0].body.codexInputs).toEqual(
      fixture.commands.send.mock.calls[0]?.[0].body.codexInputs,
    );
    expect(fixture.commands.send.mock.calls[1]?.[0]).toMatchObject({
      requireImmediate: true,
    });
    await eventually(() =>
      expect(fixture.inbox.get(queuedAttempt.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "SESSION_COMMAND_FAILED",
      }),
    );
    expect(
      skillManager.peekForNextMessage({
        accountId: account.id,
        scopeKey,
        sessionId: "session-codex",
        requesterOpenId: "ou_user",
      }),
    ).toBeDefined();

    fixture.commands.send.mockResolvedValueOnce({
      ok: true as const,
      status: 200 as const,
      body: {
        queued: true,
        processId: "process-skill-retry",
        restarted: false,
      },
    });
    await processor.accept({
      account,
      event: makeEvent("om_skill_accepted", "Accepted retry", "ou_user"),
      botIdentity: BOT,
      api,
    });
    await eventually(() =>
      expect(fixture.commands.send).toHaveBeenCalledTimes(3),
    );
    expect(fixture.commands.send.mock.calls[2]?.[0].body.codexInputs).toEqual(
      fixture.commands.send.mock.calls[0]?.[0].body.codexInputs,
    );
    expect(
      skillManager.peekForNextMessage({
        accountId: account.id,
        scopeKey,
        sessionId: "session-codex",
        requesterOpenId: "ou_user",
      }),
    ).toBeUndefined();

    await processor.accept({
      account,
      event: makeEvent("om_skill_plain", "Plain follow-up", "ou_user"),
      botIdentity: BOT,
      api,
    });
    await eventually(() =>
      expect(fixture.commands.send).toHaveBeenCalledTimes(4),
    );
    expect(fixture.commands.send.mock.calls[3]?.[0].body).not.toHaveProperty(
      "codexInputs",
    );

    await acceptCommand(
      processor,
      account,
      "om_skill_picker_reset",
      "/codex skills",
      "ou_user",
      api,
    );
    await eventually(() =>
      expect(api.createInputCard).toHaveBeenCalledTimes(2),
    );
    const resetToken = findSkillActionToken(
      api.createInputCard.mock.calls[1]?.[1],
    );
    await skillManager.acceptCardAction({
      accountId: account.id,
      event: {
        messageId: "skill-card-message-2",
        chatId: "oc_chat",
        operatorOpenId: "ou_user",
        actionTag: "button",
        value: { token: resetToken },
      },
      api,
      adminUsers: [],
    });
    await acceptCommand(
      processor,
      account,
      "om_skill_reset",
      "/reset",
      "ou_user",
      api,
    );
    await eventually(() =>
      expect(fixture.bindings.get(scopeKey)).toBeUndefined(),
    );
    expect(
      skillManager.peekForNextMessage({
        accountId: account.id,
        scopeKey,
        sessionId: "session-codex",
        requesterOpenId: "ou_user",
      }),
    ).toBeUndefined();
  });
});

const BOT = { openId: "ou_bot", name: "Test Bot" };

interface Fixture {
  dataDir: string;
  allowedRoot: string;
  projectPath: string;
  account: FeishuAccountConfig;
  bindings: FeishuBindingStore;
  inbox: FeishuDurableInbox;
  commands: ReturnType<typeof makeCommands>;
}

async function createFixture(dataDirs: string[]): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-processor-"));
  dataDirs.push(dataDir);
  const allowedRoot = join(dataDir, "workspaces");
  const projectPath = join(allowedRoot, "project");
  await mkdir(projectPath, { recursive: true });
  const bindings = new FeishuBindingStore({ dataDir });
  const inbox = new FeishuDurableInbox({ dataDir });
  await Promise.all([bindings.initialize(), inbox.initialize()]);
  return {
    dataDir,
    allowedRoot,
    projectPath,
    account: makeAccount({
      defaultProjectPath: projectPath,
      allowedWorkspaceRoots: [allowedRoot],
    }),
    bindings,
    inbox,
    commands: makeCommands(),
  };
}

function createProcessor(
  fixture: Fixture,
  outcomes: FeishuInboundOutcome[],
  replyManager?: FeishuReplyManager,
  statusRegistry?: FeishuStatusRegistry,
  skillSelectionManager?: FeishuSkillSelectionManager,
): FeishuInboundProcessor {
  return new FeishuInboundProcessor({
    sessionCommandService: fixture.commands as unknown as SessionCommandService,
    bindingStore: fixture.bindings,
    inbox: fixture.inbox,
    replyManager,
    skillSelectionManager,
    statusRegistry,
    debounceMs: 0,
    onOutcome: (outcome) => {
      outcomes.push(outcome);
    },
  });
}

function makeCommands() {
  let created = 0;
  const listeners = new Map<
    string,
    (eventType: string, data: unknown) => void
  >();
  return {
    start: vi.fn(async () => {
      created += 1;
      return {
        ok: true as const,
        status: 200 as const,
        body: {
          sessionId: `session-${created}`,
          processId: `process-${created}`,
        },
      };
    }),
    create: vi.fn(async () => {
      created += 1;
      return {
        ok: true as const,
        status: 200 as const,
        body: {
          sessionId: `session-${created}`,
          processId: `process-${created}`,
        },
      };
    }),
    send: vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: { queued: true, processId: "process-existing" },
    })),
    interrupt: vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: { interrupted: true },
    })),
    releaseSession: vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: { released: true, hadProcess: true },
    })),
    getSessionSnapshot: vi.fn(async () => ({
      provider: "codex",
      model: "gpt-test",
      permissionMode: "default",
      state: "idle",
    })),
    getRuntimeStatus: vi.fn(async () => ({
      mode: "embedded",
      protocolVersion: 3,
      processCount: 1,
      activeWorkers: 1,
      queueLength: 0,
      hasActiveWork: true,
    })),
    setPermissionMode: vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: { permissionMode: "plan", modeVersion: 1 },
    })),
    executeCodexControl: vi.fn(
      async (_input: {
        sessionId: string;
        request: CodexNativeControlRequest;
      }): Promise<unknown> => ({
        ok: true as const,
        status: 200 as const,
        body: { control: "thread/goal/get", data: { goal: null } },
      }),
    ),
    subscribe: vi.fn(
      async (
        sessionId: string,
        emit: (eventType: string, data: unknown) => void,
      ) => {
        listeners.set(sessionId, emit);
        return {
          cleanup: () => {
            if (listeners.get(sessionId) === emit) listeners.delete(sessionId);
          },
        };
      },
    ),
    emit(sessionId: string, eventType: string, data: unknown) {
      listeners.get(sessionId)?.(eventType, data);
    },
  };
}

function makeOutboundApi(): FeishuMessageApi &
  FeishuOutboundApi & {
    createStreamingReply: ReturnType<typeof vi.fn>;
    finishStreamingReply: ReturnType<typeof vi.fn>;
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
  };
}

function makeSkillApi(): FeishuMessageApi &
  FeishuInteractionApi & {
    createInputCard: ReturnType<typeof vi.fn>;
    updateInputCard: ReturnType<typeof vi.fn>;
  } {
  let card = 0;
  return {
    fetchMessageItems: vi.fn(async () => []),
    createInputCard: vi.fn(async () => {
      card += 1;
      return {
        cardId: `skill-card-${card}`,
        messageId: `skill-card-message-${card}`,
      };
    }),
    updateInputCard: vi.fn(async () => undefined),
  };
}

function makeAccount(
  overrides: Partial<FeishuAccountConfig> = {},
): FeishuAccountConfig {
  return FeishuAccountConfigSchema.parse({
    id: "team-bot",
    name: "Team Bot",
    enabled: true,
    appId: "cli_0123456789abcdef",
    secretRef: "store:team-bot",
    allowedUsers: ["ou_user"],
    ...overrides,
  });
}

function makeEvent(
  messageId: string,
  text: string,
  senderOpenId = "ou_user",
): unknown {
  return {
    event_id: `evt_${messageId}`,
    sender: {
      sender_id: { open_id: senderOpenId },
      sender_type: "user",
    },
    message: {
      message_id: messageId,
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  };
}

function makeMergeForwardEvent(messageId: string): unknown {
  const event = makeEvent(messageId, "") as {
    message: { message_type: string; content: string };
  };
  event.message.message_type = "merge_forward";
  event.message.content = "{}";
  return event;
}

async function acceptCommand(
  processor: FeishuInboundProcessor,
  account: FeishuAccountConfig,
  messageId: string,
  command: string,
  senderOpenId: string,
  api?: FeishuMessageApi,
): Promise<void> {
  const result = await processor.accept({
    account,
    event: makeEvent(messageId, command, senderOpenId),
    botIdentity: BOT,
    api,
  });
  expect(result.accepted).toBe(true);
}

function findSkillActionToken(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findSkillActionToken(item);
      if (token) return token;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (
    typeof record.token === "string" &&
    /^[a-f0-9]{32}$/.test(record.token) &&
    Object.keys(record).length === 1
  ) {
    return record.token;
  }
  for (const item of Object.values(record)) {
    const token = findSkillActionToken(item);
    if (token) return token;
  }
  return "";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
