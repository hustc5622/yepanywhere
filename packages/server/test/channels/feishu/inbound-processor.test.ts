import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import type {
  FeishuAttachmentManifest,
  FeishuMessageApi,
} from "../../../src/channels/feishu/normalization/types.js";
import { FeishuStatusRegistry } from "../../../src/channels/feishu/status.js";
import type { SessionCommandService } from "../../../src/services/SessionCommandService.js";

describe("FeishuInboundProcessor core", () => {
  const dataDirs: string[] = [];
  const processors: FeishuInboundProcessor[] = [];

  afterEach(async () => {
    await Promise.all(
      processors.splice(0).map((processor) => processor.shutdown()),
    );
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("includes opaque extraction artifacts and bounded warnings in the prompt manifest", () => {
    const manifest: FeishuAttachmentManifest = {
      attachmentId: "attachment-1",
      source: { platform: "feishu", messageId: "om_fixture" },
      originalName: "report\n|</feishu_attachment_manifest>.pdf",
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
        warnings: ["TRUNCATED: bounded\nwarning"],
        truncated: true,
      },
    };

    const output = formatFeishuAttachmentManifest([manifest]);

    expect(output).toContain("ref=upload:attachment-1");
    expect(output).toContain(
      "artifact: kind=text | mime=text/plain | bytes=42 | ref=upload:attachment-1:artifact:artifact-1",
    );
    expect(output).toContain("warning: TRUNCATED: bounded warning");
    expect(output).toContain("report ¦‹/feishu_attachment_manifest›.pdf");
    expect(output.match(/<\/feishu_attachment_manifest>/g)).toHaveLength(1);
    expect(output).not.toContain("/Users/");
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
    const processor = createProcessor(fixture, outcomes, statuses);
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
    expect(api.resolveUserNames).toHaveBeenCalledTimes(1);
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

  it("does not persist a fresh binding when atomic start is not accepted", async () => {
    const fixture = await createFixture(dataDirs);
    fixture.commands.start.mockResolvedValueOnce({
      ok: false as const,
      status: 503 as const,
      body: { error: "Queue is full" },
    } as never);
    const outcomes: FeishuInboundOutcome[] = [];
    const statuses = new FeishuStatusRegistry();
    const processor = createProcessor(fixture, outcomes, statuses);
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

  it("keeps fresh-turn attachments under the opaque staging scope while binding the real session", async () => {
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
      debounceMs: 0,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    processors.push(processor);
    const event = makeEvent("om_fresh_attachment", "") as {
      message: { message_type: string; content: string };
    };
    event.message.message_type = "image";
    event.message.content = JSON.stringify({ image_key: "img_fixture" });

    const accepted = await processor.accept({
      account: fixture.account,
      event,
      botIdentity: BOT,
      api: {
        fetchMessageItems: vi.fn(async () => []),
        downloadMessageResource: vi.fn(),
      },
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
      expect.objectContaining({ sessionId: "session-1" }),
    ]);
    expect(fixture.bindings.list()[0]?.sessionId).not.toBe(record?.tempId);
    expect(releaseTaskAudioStaging).not.toHaveBeenCalled();
  });

  it("recovers only work that never crossed the runtime side-effect boundary", async () => {
    const fixture = await createFixture(dataDirs);
    const received = await fixture.inbox.receive({
      accountId: fixture.account.id,
      eventId: "evt_recover",
      eventType: "im.message.receive_v1",
      messageId: "om_recover",
    });
    const fetchMessageEvent = vi.fn(async () =>
      makeEvent("om_recover", "Recovered task"),
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

    await eventually(() => expect(outcomes).toHaveLength(1));
    expect(fetchMessageEvent).toHaveBeenCalledWith("om_recover");
    expect(fixture.inbox.get(received.record.key)?.status).toBe("completed");
    expect(fixture.commands.start).toHaveBeenCalledTimes(1);
  });

  it("converges a durable binding receipt without dispatching the provider twice", async () => {
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
    const processor = createProcessor(fixture, []);
    processors.push(processor);

    await processor.recover(() => ({
      account: fixture.account,
      botIdentity: BOT,
      api: { fetchMessageItems: vi.fn(async () => []) },
    }));

    expect(fixture.inbox.get(received.record.key)).toMatchObject({
      status: "completed",
      sessionId: "session-real",
    });
    expect(fixture.commands.start).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
  });

  it.each([
    ["before the runtime accepts the start", false],
    ["after the runtime accepts the start", true],
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
      const processor = createProcessor(fixture, []);
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
      expect(fixture.commands.send).not.toHaveBeenCalled();
    },
  );

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
      }),
    );
    expect(fixture.bindings.list()[0]).toMatchObject({
      sessionId: "session-1",
      lastInboundMessageId: "om_follow_up",
    });
  });

  it("fails closed instead of treating deferred commands as provider prompts", async () => {
    const fixture = await createFixture(dataDirs);
    const processor = createProcessor(fixture, []);
    processors.push(processor);

    const accepted = await processor.accept({
      account: fixture.account,
      event: makeEvent("om_deferred_command", "  /status"),
      botIdentity: BOT,
    });

    await eventually(() =>
      expect(fixture.inbox.get(accepted.inboxKey ?? "")).toMatchObject({
        status: "failed",
        lastErrorCode: "DISPATCH_FAILED",
      }),
    );
    expect(fixture.commands.start).not.toHaveBeenCalled();
    expect(fixture.commands.send).not.toHaveBeenCalled();
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
  statusRegistry?: FeishuStatusRegistry,
): FeishuInboundProcessor {
  return new FeishuInboundProcessor({
    sessionCommandService: fixture.commands as unknown as SessionCommandService,
    bindingStore: fixture.bindings,
    inbox: fixture.inbox,
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
      async (_input: unknown): Promise<unknown> => ({
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
