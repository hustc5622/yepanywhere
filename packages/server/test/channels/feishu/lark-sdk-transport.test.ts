import { FeishuAccountConfigSchema } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  clientOptions: [] as Array<Record<string, unknown>>,
  wsOptions: [] as Array<Record<string, unknown>>,
  httpInstance: {
    defaults: {} as Record<string, unknown>,
    request: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(),
    options: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
  },
  handlers: {} as Record<string, (event: unknown) => Promise<void>>,
  request: vi.fn(),
  register: vi.fn(),
  wsStart: vi.fn(),
  wsClose: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  function Client(options: Record<string, unknown>) {
    sdk.clientOptions.push(options);
    return { request: sdk.request };
  }

  function EventDispatcher() {
    return {
      register: sdk.register.mockImplementation(
        (handlers: Record<string, (event: unknown) => Promise<void>>) => {
          Object.assign(sdk.handlers, handlers);
        },
      ),
    };
  }

  function WSClient(options: Record<string, unknown>) {
    sdk.wsOptions.push(options);
    return { start: sdk.wsStart, close: sdk.wsClose };
  }

  return {
    AppType: { SelfBuild: "self-build" },
    Client,
    defaultHttpInstance: sdk.httpInstance,
    Domain: { Feishu: "domain-feishu", Lark: "domain-lark" },
    EventDispatcher,
    LoggerLevel: { error: "error" },
    normalizeCardAction(event: Record<string, unknown>) {
      const context = event.context as Record<string, unknown> | undefined;
      const operator = event.operator as Record<string, unknown> | undefined;
      const action = event.action as Record<string, unknown> | undefined;
      if (
        typeof context?.open_message_id !== "string" ||
        typeof context.open_chat_id !== "string" ||
        typeof operator?.open_id !== "string"
      ) {
        return null;
      }
      return {
        messageId: context.open_message_id,
        chatId: context.open_chat_id,
        operator: { openId: operator.open_id },
        action: {
          tag: action?.tag ?? "unknown",
          value: action?.value,
          option: action?.option,
        },
      };
    },
    WSClient,
  };
});

import {
  LarkSdkFeishuTransport,
  LarkSdkFeishuTransportFactory,
  normalizeFeishuCardAction,
} from "../../../src/channels/feishu/lark-sdk-transport.js";
import type { FeishuTransportCallbacks } from "../../../src/channels/feishu/transport.js";

describe("LarkSdkFeishuTransport inbound boundary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    sdk.clientOptions.length = 0;
    sdk.wsOptions.length = 0;
    for (const method of [
      sdk.httpInstance.request,
      sdk.httpInstance.get,
      sdk.httpInstance.delete,
      sdk.httpInstance.head,
      sdk.httpInstance.options,
      sdk.httpInstance.post,
      sdk.httpInstance.put,
      sdk.httpInstance.patch,
    ]) {
      method.mockReset().mockResolvedValue({});
    }
    for (const key of Object.keys(sdk.handlers)) delete sdk.handlers[key];
    sdk.request.mockReset().mockResolvedValue({
      bot: { open_id: "ou_bot_fixture", app_name: "Fixture Bot" },
    });
    sdk.register.mockClear();
    sdk.wsClose.mockReset();
    sdk.wsStart.mockReset().mockImplementation(async () => {
      const onReady = sdk.wsOptions.at(-1)?.onReady;
      if (typeof onReady === "function") onReady();
    });
  });

  it("is inert until explicitly started", () => {
    const factory = new LarkSdkFeishuTransportFactory();
    const transport = factory.create({
      account: makeAccount(),
      appSecret: "fixture-secret",
      callbacks: makeCallbacks(),
    });

    expect(transport).toBeInstanceOf(LarkSdkFeishuTransport);
    expect(sdk.clientOptions).toHaveLength(0);
    expect(sdk.wsOptions).toHaveLength(0);
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it("loads the Batch 6 core barrel without filesystem or network startup", async () => {
    const core = await import("../../../src/channels/feishu/index.js");

    expect(core.FeishuInboundProcessor).toBeTypeOf("function");
    expect(core.LarkSdkFeishuTransportFactory).toBeTypeOf("function");
    expect(sdk.clientOptions).toHaveLength(0);
    expect(sdk.wsOptions).toHaveLength(0);
    expect(sdk.request).not.toHaveBeenCalled();
  });

  it("authenticates one account and forwards normalized inbound events", async () => {
    const callbacks = makeCallbacks();
    const transport = new LarkSdkFeishuTransport({
      account: makeAccount({ domain: "lark" }),
      appSecret: "fixture-secret",
      callbacks,
      connectTimeoutMs: 100,
    });

    await transport.start();

    expect(sdk.clientOptions).toEqual([
      expect.objectContaining({
        appId: "cli_0123456789abcdef",
        appSecret: "fixture-secret",
        domain: "domain-lark",
      }),
    ]);
    expect(sdk.clientOptions[0]).not.toHaveProperty("httpInstance");
    expect(sdk.request).toHaveBeenCalledWith({
      url: "/open-apis/bot/v3/info",
      method: "GET",
    });
    expect(callbacks.onBotIdentity).toHaveBeenCalledWith({
      openId: "ou_bot_fixture",
      name: "Fixture Bot",
    });
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
    expect(sdk.wsOptions.at(-1)).not.toHaveProperty("httpInstance");
    expect(Object.keys(sdk.handlers).sort()).toEqual([
      "card.action.trigger",
      "im.message.reaction.created_v1",
      "im.message.reaction.deleted_v1",
      "im.message.recalled_v1",
      "im.message.receive_v1",
    ]);

    const event = { event_id: "evt_fixture" };
    await sdk.handlers["im.message.receive_v1"]?.(event);
    expect(callbacks.onMessage).toHaveBeenCalledWith(
      event,
      transport.getMessageApi(),
    );

    await sdk.handlers["im.message.recalled_v1"]?.({
      event_id: "evt_recall_fixture",
      message_id: "om_fixture",
      recall_time: "3000",
      recall_type: "message_owner",
    });
    expect(callbacks.onMessageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_recall_fixture",
        messageId: "om_fixture",
        kind: "recalled",
      }),
      transport.getMessageApi(),
    );

    const cardAction = {
      context: {
        open_message_id: "om_card_fixture",
        open_chat_id: "oc_chat_fixture",
      },
      operator: { open_id: "ou_user_fixture" },
      action: {
        tag: "button",
        value: {
          namespace: "yep-feishu",
          operationId: "int_fixture_operation_0001",
          operationVersion: 0,
          action: "approve",
        },
        form_value: { q_0: "1" },
      },
    };
    await sdk.handlers["card.action.trigger"]?.(cardAction);
    expect(callbacks.onCardAction).toHaveBeenCalledWith(
      {
        messageId: "om_card_fixture",
        chatId: "oc_chat_fixture",
        operatorOpenId: "ou_user_fixture",
        actionTag: "button",
        value: cardAction.action.value,
        option: undefined,
        formValue: { q_0: "1" },
      },
      transport.getMessageApi(),
    );

    await transport.stop();
    expect(sdk.wsClose).toHaveBeenCalledTimes(1);
    expect(transport.getMessageApi()).toBeUndefined();
  });

  it("bypasses inherited proxies for Feishu without mutating the SDK default", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8485/private-value");
    const transport = new LarkSdkFeishuTransport({
      account: makeAccount(),
      appSecret: "fixture-secret",
      callbacks: makeCallbacks(),
    });

    await transport.start();

    const directHttpInstance = sdk.clientOptions.at(-1)?.httpInstance as
      | { request(options: Record<string, unknown>): Promise<unknown> }
      | undefined;
    expect(directHttpInstance).toBeDefined();
    expect(directHttpInstance).not.toBe(sdk.httpInstance);
    expect(sdk.wsOptions.at(-1)?.httpInstance).toBe(directHttpInstance);
    expect(sdk.httpInstance.defaults).toEqual({});

    await directHttpInstance?.request({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
    });
    expect(sdk.httpInstance.request).toHaveBeenCalledWith({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      proxy: false,
    });
  });

  it("honors an account-level environment proxy override for Feishu", async () => {
    const transport = new LarkSdkFeishuTransport({
      account: makeAccount({ proxyMode: "environment" }),
      appSecret: "fixture-secret",
      callbacks: makeCallbacks(),
    });

    await transport.start();

    expect(sdk.clientOptions.at(-1)).not.toHaveProperty("httpInstance");
    expect(sdk.wsOptions.at(-1)).not.toHaveProperty("httpInstance");
  });

  it("allows an account-level direct override for international Lark", async () => {
    const transport = new LarkSdkFeishuTransport({
      account: makeAccount({ domain: "lark", proxyMode: "direct" }),
      appSecret: "fixture-secret",
      callbacks: makeCallbacks(),
    });

    await transport.start();

    expect(sdk.clientOptions.at(-1)?.httpInstance).toBeDefined();
    expect(sdk.wsOptions.at(-1)?.httpInstance).toBe(
      sdk.clientOptions.at(-1)?.httpInstance,
    );
  });

  it("fails closed before WebSocket startup when bot identity cannot be verified", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8485/private-value");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk.request.mockRejectedValueOnce(
      Object.assign(new Error("fixture identity failure"), {
        code: "ECONNREFUSED",
      }),
    );
    const callbacks = makeCallbacks();
    const transport = new LarkSdkFeishuTransport({
      account: makeAccount(),
      appSecret: "fixture-secret",
      callbacks,
    });

    await expect(transport.start()).rejects.toThrow(
      "FEISHU_BOT_IDENTITY_FAILED",
    );
    expect(callbacks.onTerminalError).toHaveBeenCalledWith(
      "BOT_IDENTITY_FAILED",
    );
    expect(sdk.wsOptions).toHaveLength(0);
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      "[Feishu] event=feishu_transport_request_failed accountId=fixture-bot phase=bot_identity errorCode=ECONNREFUSED httpStatus=none inheritedProxy=true proxyBypassed=true",
    );
    expect(warning.mock.calls.flat().join(" ")).not.toContain("8485");
  });

  it("rejects malformed card-action envelopes at the transport boundary", () => {
    expect(
      normalizeFeishuCardAction({
        context: { open_message_id: "om_missing_chat" },
        operator: { open_id: "ou_fixture" },
        action: { tag: "button", value: {} },
      }),
    ).toBeUndefined();
  });
});

function makeAccount(overrides: Record<string, unknown> = {}) {
  return FeishuAccountConfigSchema.parse({
    id: "fixture-bot",
    name: "Fixture Bot",
    enabled: true,
    appId: "cli_0123456789abcdef",
    secretRef: "store:fixture-bot",
    allowedUsers: ["ou_user_fixture"],
    ...overrides,
  });
}

function makeCallbacks(): FeishuTransportCallbacks & {
  [Key in keyof FeishuTransportCallbacks]: ReturnType<typeof vi.fn>;
} {
  return {
    onBotIdentity: vi.fn(),
    onReady: vi.fn(),
    onReconnecting: vi.fn(),
    onReconnected: vi.fn(),
    onApiSuccess: vi.fn(),
    onTerminalError: vi.fn(),
    onMessage: vi.fn(),
    onMessageMutation: vi.fn(),
    onCardAction: vi.fn(),
  };
}
