import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FeishuAccountConfig,
  FeishuAccountConfigSchema,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuChannelService } from "../../../src/channels/feishu/service.js";
import type {
  FeishuTransport,
  FeishuTransportCallbacks,
  FeishuTransportFactory,
  FeishuTransportFactoryInput,
} from "../../../src/channels/feishu/transport.js";

describe("FeishuChannelService", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("connects configured accounts, receives events and closes owned transports", async () => {
    const dataDir = await createDataDir(dataDirs);
    const factory = new FakeTransportFactory();
    const onMessage = vi.fn(async () => undefined);
    const onCardAction = vi.fn(async () => undefined);
    const service = new FeishuChannelService({
      dataDir,
      transportFactory: factory,
      onMessage,
      onCardAction,
    });
    await service.initialize();
    await service.upsertAccount(makeAccount());

    expect(service.listStatuses()[0]).toMatchObject({
      accountId: "team-bot",
      state: "degraded",
      lastErrorCode: "SECRET_MISSING",
    });

    const publicAccount = await service.setSecret(
      "team-bot",
      "fixture-credential-value",
    );
    expect(publicAccount).toMatchObject({
      id: "team-bot",
      secret: { configured: true, masked: "****alue" },
    });
    expect(publicAccount).not.toHaveProperty("secretRef");
    expect(factory.transports).toHaveLength(1);
    expect(factory.inputs[0]?.appSecret).toBe("fixture-credential-value");
    expect(service.listStatuses()[0]?.state).toBe("connected");

    await factory.transports[0]?.emit({ event_id: "evt_test" });
    expect(onMessage).toHaveBeenCalledWith({
      account: expect.objectContaining({ id: "team-bot" }),
      event: { event_id: "evt_test" },
      botIdentity: { openId: "ou_bot", name: "Test Bot" },
    });
    await factory.transports[0]?.emit({
      sender: {
        sender_type: "app",
        sender_id: { open_id: "ou_bot" },
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    await factory.transports[0]?.emitCardAction({
      messageId: "om_card",
      chatId: "oc_chat",
      operatorOpenId: "ou_user",
      actionTag: "button",
      value: { namespace: "yep-feishu" },
    });
    expect(onCardAction).toHaveBeenCalledWith({
      account: expect.objectContaining({ id: "team-bot" }),
      event: expect.objectContaining({ messageId: "om_card" }),
    });
    expect(service.listStatuses()[0]?.lastEventAt).toBeDefined();
    expect(service.listStatuses()[0]?.metrics).toMatchObject({
      eventsReceived: 3,
      messagesReceived: 2,
      cardActionsReceived: 1,
    });
    expect(service.diagnostics().messageMutationPipeline).toMatchObject({
      durableState: {
        operational: true,
        persistedEvents: 0,
        contentStored: false,
      },
      consumerCallback: "not_configured",
      deliveryGuarantee: "durable_state_only",
      canonicalTranscript: "not_wired",
      uiProjection: "diagnostics_only",
    });

    await service.shutdown();
    expect(factory.transports[0]?.stop).toHaveBeenCalledTimes(1);
    expect(service.listStatuses()[0]?.state).toBe("stopped");
  });

  it("does not connect an enabled account until an inbound handler exists", async () => {
    const dataDir = await createDataDir(dataDirs);
    const factory = new FakeTransportFactory();
    const service = new FeishuChannelService({
      dataDir,
      transportFactory: factory,
    });
    await service.initialize();
    await service.upsertAccount(makeAccount());
    await service.setSecret("team-bot", "fixture-credential-value");

    expect(factory.transports).toHaveLength(0);
    expect(service.listStatuses()[0]).toMatchObject({
      state: "degraded",
      lastErrorCode: "INBOUND_HANDLER_MISSING",
    });
  });

  it("persists recall/reaction mutations before notifying consumers", async () => {
    const dataDir = await createDataDir(dataDirs);
    const factory = new FakeTransportFactory();
    const onMessageMutation = vi.fn(async () => undefined);
    const service = new FeishuChannelService({
      dataDir,
      transportFactory: factory,
      onMessage: () => undefined,
      onMessageMutation,
    });
    await service.initialize();
    await service.upsertAccount(makeAccount());
    await service.setSecret("team-bot", "fixture-credential-value");

    await factory.transports[0]?.emitMessageMutation({
      version: 1,
      eventId: "evt_recall",
      eventType: "im.message.recalled_v1",
      messageId: "om_recalled",
      kind: "recalled",
      occurredAtMs: 1_786_063_200_000,
      source: "event",
      recallType: "message_owner",
    });
    await factory.transports[0]?.emitMessageMutation({
      version: 1,
      eventId: "evt_recall",
      eventType: "im.message.recalled_v1",
      messageId: "om_recalled",
      kind: "recalled",
      occurredAtMs: 1_786_063_200_000,
      source: "event",
      recallType: "message_owner",
    });

    expect(onMessageMutation).toHaveBeenCalledTimes(1);
    expect(onMessageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({ eventId: "evt_recall" }),
        state: expect.objectContaining({
          revision: 1,
          recalledAtMs: 1_786_063_200_000,
        }),
      }),
    );
    expect(
      service.getMessageMutationState("team-bot", "om_recalled"),
    ).toMatchObject({
      revision: 1,
      recalledAtMs: 1_786_063_200_000,
    });
    expect(
      service.diagnostics().messageMutationCapabilities.edit,
    ).toMatchObject({
      support: "opportunistic_read_observation",
      eventType: null,
      scheduledPolling: false,
    });
    expect(service.diagnostics().messageMutationPipeline).toMatchObject({
      ingress: {
        recall: "official_event",
        reactions: "official_event",
        edit: "opportunistic_message_read_observation",
      },
      durableState: { operational: true, persistedEvents: 1 },
      accountStatus: "event_received_only",
      consumerCallback: "configured_best_effort",
      deliveryGuarantee: "durable_state_then_best_effort_callback",
      canonicalTranscript: "external_consumer_owned_unverified",
      uiProjection: "external_consumer_owned_unverified",
    });
    expect(service.getPermissionRequirements("team-bot")?.events).toEqual([
      "im.message.receive_v1",
      "im.message.recalled_v1",
      "im.message.reaction.created_v1",
      "im.message.reaction.deleted_v1",
    ]);
    await service.shutdown();
  });

  it("retries an initial transport failure with bounded backoff", async () => {
    const dataDir = await createDataDir(dataDirs);
    let creates = 0;
    const transportFactory: FeishuTransportFactory = {
      create: ({ callbacks }) => {
        creates += 1;
        const attempt = creates;
        return {
          start: async () => {
            if (attempt === 1) {
              callbacks.onTerminalError("WS_START_FAILED");
              throw new Error("transient connection failure");
            }
            callbacks.onBotIdentity({ openId: "ou_bot" });
            callbacks.onReady();
          },
          stop: async () => undefined,
        };
      },
    };
    const service = new FeishuChannelService({
      dataDir,
      transportFactory,
      onMessage: () => undefined,
      connectionRetry: { baseMs: 1, maxMs: 1, random: () => 0 },
    });
    await service.initialize();
    await service.upsertAccount(makeAccount());
    await service.setSecret("team-bot", "fixture-credential-value");

    await eventually(() => {
      expect(creates).toBe(2);
      expect(service.listStatuses()[0]?.state).toBe("connected");
    });
    await service.shutdown();
  });

  it("preserves a transport terminal error instead of relabeling it as WebSocket startup", async () => {
    const dataDir = await createDataDir(dataDirs);
    const transportFactory: FeishuTransportFactory = {
      create: ({ callbacks }) => ({
        start: async () => {
          callbacks.onTerminalError("BOT_IDENTITY_FAILED");
          throw new Error("synthetic identity failure");
        },
        stop: async () => undefined,
      }),
    };
    const service = new FeishuChannelService({
      dataDir,
      transportFactory,
      onMessage: () => undefined,
      connectionRetry: { baseMs: 60_000, maxMs: 60_000, random: () => 0 },
    });
    await service.initialize();
    await service.upsertAccount(makeAccount());
    await service.setSecret("team-bot", "fixture-credential-value");

    expect(service.listStatuses()[0]).toMatchObject({
      state: "degraded",
      lastErrorCode: "BOT_IDENTITY_FAILED",
    });
    await service.shutdown();
  });

  it("fails all duplicate enabled App IDs closed", async () => {
    const dataDir = await createDataDir(dataDirs);
    const factory = new FakeTransportFactory();
    const service = new FeishuChannelService({
      dataDir,
      transportFactory: factory,
      onMessage: () => undefined,
    });
    await service.initialize();
    await service.upsertAccount(makeAccount({ enabled: false }));
    await service.setSecret("team-bot", "fixture-credential-one");
    await service.upsertAccount(
      makeAccount({ id: "second-bot", name: "Second", enabled: false }),
    );
    await service.setSecret("second-bot", "fixture-credential-two");
    await service.upsertAccount(makeAccount());
    await service.upsertAccount(
      makeAccount({ id: "second-bot", name: "Second" }),
    );

    expect(factory.transports).toHaveLength(1);
    expect(factory.transports[0]?.stop).toHaveBeenCalledTimes(1);
    expect(service.listStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "team-bot",
          state: "degraded",
          lastErrorCode: "DUPLICATE_APP_ID",
        }),
        expect.objectContaining({
          accountId: "second-bot",
          state: "degraded",
          lastErrorCode: "DUPLICATE_APP_ID",
        }),
      ]),
    );
  });

  it("reports stable diagnostics without exposing Secret material", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    await service.initialize();
    await service.upsertAccount(makeAccount());
    await service.setSecret("team-bot", "fixture-sensitive-material");

    const doctor = service.doctor();
    expect(doctor).toMatchObject({
      ok: false,
      accounts: [
        {
          accountId: "team-bot",
          secretConfigured: true,
          connectionState: "degraded",
        },
      ],
    });
    expect(JSON.stringify(doctor)).not.toContain("fixture-sensitive-material");
  });

  it("keeps stable doctor diagnostics available after fail-closed shutdown", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    await service.initialize();
    await service.shutdown();

    expect(service.doctor()).toEqual({
      ok: false,
      initializationErrorCode: "CHANNEL_STOPPED",
      accounts: [],
    });
    expect(service.diagnostics()).toMatchObject({
      operational: false,
      doctor: { initializationErrorCode: "CHANNEL_STOPPED" },
    });
  });
});

class FakeTransportFactory implements FeishuTransportFactory {
  readonly inputs: FeishuTransportFactoryInput[] = [];
  readonly transports: FakeTransport[] = [];

  create(input: FeishuTransportFactoryInput): FeishuTransport {
    this.inputs.push(input);
    const transport = new FakeTransport(input.callbacks);
    this.transports.push(transport);
    return transport;
  }
}

class FakeTransport implements FeishuTransport {
  readonly stop = vi.fn(async () => undefined);
  private readonly callbacks: FeishuTransportCallbacks;

  constructor(callbacks: FeishuTransportCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.callbacks.onBotIdentity({ openId: "ou_bot", name: "Test Bot" });
    this.callbacks.onReady();
  }

  async emit(event: unknown): Promise<void> {
    await this.callbacks.onMessage(event);
  }

  async emitCardAction(
    event: Parameters<FeishuTransportCallbacks["onCardAction"]>[0],
  ): Promise<void> {
    await this.callbacks.onCardAction(event);
  }

  async emitMessageMutation(
    event: Parameters<FeishuTransportCallbacks["onMessageMutation"]>[0],
  ): Promise<void> {
    await this.callbacks.onMessageMutation(event);
  }
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

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-service-"));
  dataDirs.push(dataDir);
  return dataDir;
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}
