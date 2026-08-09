import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FeishuAccountConfig,
  FeishuAccountConfigSchema,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuChannelRuntime } from "../../../src/channels/feishu/channel-runtime.js";
import { FeishuChannelService } from "../../../src/channels/feishu/service.js";
import type {
  FeishuTransport,
  FeishuTransportCallbacks,
  FeishuTransportFactory,
  FeishuTransportFactoryInput,
} from "../../../src/channels/feishu/transport.js";
import { encodeProjectId } from "../../../src/projects/paths.js";
import type { SessionCommandService } from "../../../src/services/SessionCommandService.js";
import { EventBus } from "../../../src/watcher/index.js";

describe("FeishuChannelRuntime", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps a clean default profile local, connection-free, and timer-free", async () => {
    const dataDir = await createDataDir(dataDirs);
    const factory = new FakeTransportFactory();
    const service = new FeishuChannelService({
      dataDir,
      transportFactory: factory,
    });
    const eventBus = new EventBus();
    const runtime = new FeishuChannelRuntime({ dataDir, service });

    await expect(runtime.prepare(eventBus)).resolves.toEqual({
      persistenceReady: true,
    });
    await expect(
      runtime.start({
        eventBus,
        sessionCommandService: emptySessionCommandService(),
      }),
    ).resolves.toEqual({
      persistenceReady: true,
      serviceOperational: true,
    });

    expect(factory.inputs).toEqual([]);
    expect(service.listAccounts()).toEqual([]);
    expect(eventBus.subscriberCount).toBe(1);
    await expect(access(join(dataDir, "channels", "feishu"))).rejects.toThrow();

    const firstShutdown = runtime.shutdown();
    const secondShutdown = runtime.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
    expect(eventBus.subscriberCount).toBe(0);
  });

  it("subscribes binding remaps before the provider runtime can replay events", async () => {
    const dataDir = await createDataDir(dataDirs);
    const eventBus = new EventBus();
    const runtime = new FeishuChannelRuntime({ dataDir });
    await runtime.prepare(eventBus);
    const now = new Date().toISOString();
    await runtime.bindingStore.upsert({
      version: 1,
      scopeKey: "account-fixture:p2p:chat-fixture",
      accountId: "account-fixture",
      chatId: "chat-fixture",
      projectId: encodeProjectId("/opt/yep-fixtures/project"),
      projectPath: "/opt/yep-fixtures/project",
      sessionId: "session-before-replay",
      provider: "codex",
      createdAt: now,
      updatedAt: now,
    });

    eventBus.emit({
      type: "session-id-changed",
      oldSessionId: "session-before-replay",
      newSessionId: "session-after-replay",
      projectId: encodeProjectId("/opt/yep-fixtures/project"),
      timestamp: now,
    });

    await vi.waitFor(() => {
      expect(
        runtime.bindingStore.get("account-fixture:p2p:chat-fixture")?.sessionId,
      ).toBe("session-after-replay");
    });
    await runtime.shutdown();
  });

  it("installs all handlers before connecting a configured account", async () => {
    const dataDir = await createDataDir(dataDirs);
    const factory = new FakeTransportFactory();
    const service = new FeishuChannelService({
      dataDir,
      transportFactory: factory,
    });
    await Promise.all([
      service.configStore.initialize(),
      service.secretStore.initialize(),
    ]);
    await service.configStore.upsert(makeAccount());
    await service.secretStore.set("account-fixture", "fixture-credential");
    const eventBus = new EventBus();
    const runtime = new FeishuChannelRuntime({ dataDir, service });

    await runtime.prepare(eventBus);
    const result = await runtime.start({
      eventBus,
      sessionCommandService: emptySessionCommandService(),
    });

    expect(result).toEqual({
      persistenceReady: true,
      serviceOperational: true,
    });
    expect(factory.inputs).toHaveLength(1);
    expect(service.listStatuses()).toEqual([
      expect.objectContaining({
        accountId: "account-fixture",
        state: "connected",
        lastErrorCode: undefined,
      }),
    ]);

    await runtime.shutdown();
    expect(factory.transports[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed without subscribing or connecting when persistence is unavailable", async () => {
    const dataDir = await createDataDir(dataDirs);
    const diagnostic = vi.fn();
    const eventBus = new EventBus();
    const factory = new FakeTransportFactory();
    const service = new FeishuChannelService({
      dataDir,
      transportFactory: factory,
    });
    const runtime = new FeishuChannelRuntime({
      dataDir,
      service,
      bindingStore: {
        initialize: async () => {
          throw new Error("private parse detail");
        },
      } as never,
      onDiagnostic: diagnostic,
    });

    await expect(runtime.prepare(eventBus)).resolves.toEqual({
      persistenceReady: false,
      errorCode: "PERSISTENCE_INITIALIZATION_FAILED",
    });
    await expect(
      runtime.start({
        eventBus,
        sessionCommandService: emptySessionCommandService(),
      }),
    ).resolves.toEqual({
      persistenceReady: false,
      serviceOperational: false,
      errorCode: "PERSISTENCE_INITIALIZATION_FAILED",
    });
    expect(diagnostic).toHaveBeenCalledWith(
      "PERSISTENCE_INITIALIZATION_FAILED",
    );
    expect(eventBus.subscriberCount).toBe(0);
    expect(factory.inputs).toEqual([]);
    await runtime.shutdown();
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

  constructor(private readonly callbacks: FeishuTransportCallbacks) {}

  async start(): Promise<void> {
    this.callbacks.onBotIdentity({ openId: "bot-fixture" });
    this.callbacks.onReady();
  }
}

function makeAccount(): FeishuAccountConfig {
  return FeishuAccountConfigSchema.parse({
    id: "account-fixture",
    name: "Fixture Bot",
    enabled: true,
    appId: "cli_0123456789abcdef",
    secretRef: "store:account-fixture",
    allowedUsers: ["user-fixture"],
  });
}

function emptySessionCommandService(): SessionCommandService {
  return {} as SessionCommandService;
}

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-runtime-"));
  dataDirs.push(dataDir);
  return dataDir;
}
