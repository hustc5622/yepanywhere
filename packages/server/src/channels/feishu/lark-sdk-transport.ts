import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuCardActionEvent } from "./input-request.js";
import { LarkSdkFeishuMessageApi } from "./lark-sdk-api.js";
import { normalizeFeishuMessageMutation } from "./message-mutation.js";
import { FeishuDurableOutbox } from "./outbox.js";
import type {
  FeishuTransport,
  FeishuTransportCallbacks,
  FeishuTransportFactory,
  FeishuTransportFactoryInput,
} from "./transport.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const silentLogger: Lark.Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

export interface LarkSdkFeishuTransportOptions
  extends FeishuTransportFactoryInput {
  connectTimeoutMs?: number;
  outbox?: FeishuDurableOutbox;
}

export class LarkSdkFeishuTransport implements FeishuTransport {
  private readonly options: LarkSdkFeishuTransportOptions;
  private wsClient?: Lark.WSClient;
  private messageApi?: LarkSdkFeishuMessageApi;
  private startPromise?: Promise<void>;
  private rejectPendingStart?: (error: Error) => void;

  constructor(options: LarkSdkFeishuTransportOptions) {
    this.options = options;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const { account, appSecret, callbacks } = this.options;
    await this.options.outbox?.initialize();
    const domain =
      account.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
    const proxyBypassed = shouldBypassProxy(account);
    const httpInstance = proxyBypassed ? directLarkHttpInstance() : undefined;
    const client = new Lark.Client({
      appId: account.appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
      ...(httpInstance ? { httpInstance } : {}),
      logger: silentLogger,
      loggerLevel: Lark.LoggerLevel.error,
    });
    this.messageApi = new LarkSdkFeishuMessageApi(client, {
      onApiSuccess: callbacks.onApiSuccess,
      ...(this.options.outbox
        ? { outbox: this.options.outbox, outboxOwner: account.id }
        : {}),
    });
    let botInfo: { bot?: { open_id?: string; app_name?: string } };
    try {
      botInfo = await client.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
    } catch (error) {
      logTransportRequestFailure(
        account.id,
        "bot_identity",
        error,
        proxyBypassed,
      );
      callbacks.onTerminalError("BOT_IDENTITY_FAILED");
      throw new Error("FEISHU_BOT_IDENTITY_FAILED");
    }
    if (!botInfo.bot?.open_id) {
      callbacks.onTerminalError("BOT_IDENTITY_FAILED");
      throw new Error("FEISHU_BOT_IDENTITY_FAILED");
    }
    callbacks.onApiSuccess();
    callbacks.onBotIdentity({
      openId: botInfo.bot.open_id,
      name: botInfo.bot.app_name,
    });
    // Recover only after the current credentials have proved their bot
    // identity. This keeps persisted intents fail-closed when an account id is
    // accidentally reused with invalid or cross-tenant credentials.
    await this.messageApi.recoverOutbox();

    const dispatcher = new Lark.EventDispatcher({ logger: silentLogger });
    dispatcher.register({
      "im.message.receive_v1": async (event) => {
        await callbacks.onMessage(event, this.messageApi);
      },
      "im.message.recalled_v1": async (event) => {
        const mutation = normalizeFeishuMessageMutation(
          "im.message.recalled_v1",
          event,
        );
        if (mutation) {
          await callbacks.onMessageMutation(mutation, this.messageApi);
        }
      },
      "im.message.reaction.created_v1": async (event) => {
        const mutation = normalizeFeishuMessageMutation(
          "im.message.reaction.created_v1",
          event,
        );
        if (mutation) {
          await callbacks.onMessageMutation(mutation, this.messageApi);
        }
      },
      "im.message.reaction.deleted_v1": async (event) => {
        const mutation = normalizeFeishuMessageMutation(
          "im.message.reaction.deleted_v1",
          event,
        );
        if (mutation) {
          await callbacks.onMessageMutation(mutation, this.messageApi);
        }
      },
      "card.action.trigger": async (event: unknown) => {
        const normalized = normalizeFeishuCardAction(event);
        if (normalized) {
          await callbacks.onCardAction(normalized, this.messageApi);
        }
      },
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.rejectPendingStart = undefined;
        operation();
      };
      const timeout = setTimeout(() => {
        settle(() => reject(new Error("FEISHU_WS_CONNECT_TIMEOUT")));
      }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      timeout.unref?.();
      this.rejectPendingStart = (error) => settle(() => reject(error));

      this.wsClient = new Lark.WSClient({
        appId: account.appId,
        appSecret,
        domain,
        ...(httpInstance ? { httpInstance } : {}),
        logger: silentLogger,
        loggerLevel: Lark.LoggerLevel.error,
        autoReconnect: true,
        source: "yep-anywhere",
        handshakeTimeoutMs:
          this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        onReady: () => {
          callbacks.onReady();
          settle(resolve);
        },
        onError: () => {
          callbacks.onTerminalError("WS_CONNECT_FAILED");
          settle(() => reject(new Error("FEISHU_WS_CONNECT_FAILED")));
        },
        onReconnecting: callbacks.onReconnecting,
        onReconnected: callbacks.onReconnected,
      });

      void this.wsClient.start({ eventDispatcher: dispatcher }).catch(() => {
        callbacks.onTerminalError("WS_START_FAILED");
        settle(() => reject(new Error("FEISHU_WS_START_FAILED")));
      });
    });
  }

  async stop(): Promise<void> {
    this.rejectPendingStart?.(new Error("FEISHU_WS_STOPPED"));
    this.wsClient?.close();
    this.wsClient = undefined;
    this.messageApi = undefined;
    this.startPromise = undefined;
  }

  getMessageApi(): LarkSdkFeishuMessageApi | undefined {
    return this.messageApi;
  }
}

let sharedDirectHttpInstance: Lark.HttpInstance | undefined;

function directLarkHttpInstance(): Lark.HttpInstance {
  if (sharedDirectHttpInstance) return sharedDirectHttpInstance;

  // Keep proxy selection scoped to the account. Mutating the SDK's shared Axios
  // defaults would also force international Lark accounts (and any future SDK
  // clients in this process) off an environment proxy they may require.
  const base = Lark.defaultHttpInstance;
  const directOptions = (
    options?: Lark.HttpRequestOptions<unknown>,
  ): Lark.HttpRequestOptions<unknown> =>
    ({ ...(options ?? {}), proxy: false }) as Lark.HttpRequestOptions<unknown>;
  sharedDirectHttpInstance = {
    request: (options: Lark.HttpRequestOptions<unknown>) =>
      base.request(directOptions(options) as never),
    get: (url: string, options?: Lark.HttpRequestOptions<unknown>) =>
      base.get(url, directOptions(options) as never),
    delete: (url: string, options?: Lark.HttpRequestOptions<unknown>) =>
      base.delete(url, directOptions(options) as never),
    head: (url: string, options?: Lark.HttpRequestOptions<unknown>) =>
      base.head(url, directOptions(options) as never),
    options: (url: string, options?: Lark.HttpRequestOptions<unknown>) =>
      base.options(url, directOptions(options) as never),
    post: (
      url: string,
      data?: unknown,
      options?: Lark.HttpRequestOptions<unknown>,
    ) => base.post(url, data, directOptions(options) as never),
    put: (
      url: string,
      data?: unknown,
      options?: Lark.HttpRequestOptions<unknown>,
    ) => base.put(url, data, directOptions(options) as never),
    patch: (
      url: string,
      data?: unknown,
      options?: Lark.HttpRequestOptions<unknown>,
    ) => base.patch(url, data, directOptions(options) as never),
  } as unknown as Lark.HttpInstance;
  return sharedDirectHttpInstance;
}

function shouldBypassProxy(
  account: FeishuTransportFactoryInput["account"],
): boolean {
  if (account.proxyMode === "direct") return true;
  if (account.proxyMode === "environment") return false;
  return account.domain === "feishu";
}

function logTransportRequestFailure(
  accountId: string,
  phase: string,
  error: unknown,
  proxyBypassed: boolean,
): void {
  const errorRecord = asRecord(error);
  const causeRecord = asRecord(errorRecord?.cause);
  const responseRecord = asRecord(errorRecord?.response);
  const errorCode = sanitizeLogToken(
    typeof errorRecord?.code === "string"
      ? errorRecord.code
      : typeof causeRecord?.code === "string"
        ? causeRecord.code
        : "UNKNOWN",
  );
  const httpStatus =
    typeof responseRecord?.status === "number" &&
    Number.isFinite(responseRecord.status)
      ? Math.trunc(responseRecord.status)
      : "none";
  const inheritedProxy = PROXY_ENV_KEYS.some((key) =>
    Boolean(process.env[key]?.trim()),
  );
  console.warn(
    `[Feishu] event=feishu_transport_request_failed accountId=${sanitizeLogToken(accountId)} phase=${sanitizeLogToken(phase)} errorCode=${errorCode} httpStatus=${httpStatus} inheritedProxy=${inheritedProxy} proxyBypassed=${proxyBypassed}`,
  );
}

function sanitizeLogToken(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return safe || "UNKNOWN";
}

export function normalizeFeishuCardAction(
  event: unknown,
): FeishuCardActionEvent | undefined {
  const raw = asRecord(event);
  if (!raw) return undefined;
  const normalized = Lark.normalizeCardAction(raw as Lark.RawCardActionEvent);
  if (!normalized) return undefined;
  const action = asRecord(raw.action);
  const formValue =
    asRecord(action?.form_value) ??
    asRecord(action?.formValue) ??
    asRecord(raw.form_value);
  return {
    messageId: normalized.messageId,
    chatId: normalized.chatId,
    operatorOpenId: normalized.operator.openId,
    actionTag: normalized.action.tag,
    value: normalized.action.value,
    option: normalized.action.option,
    ...(formValue ? { formValue } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class LarkSdkFeishuTransportFactory implements FeishuTransportFactory {
  private readonly outbox?: FeishuDurableOutbox;

  constructor(options: { dataDir?: string } = {}) {
    this.outbox = options.dataDir
      ? new FeishuDurableOutbox({ dataDir: options.dataDir })
      : undefined;
  }

  create(input: FeishuTransportFactoryInput): FeishuTransport {
    return new LarkSdkFeishuTransport({
      ...input,
      ...(this.outbox ? { outbox: this.outbox } : {}),
    });
  }
}
