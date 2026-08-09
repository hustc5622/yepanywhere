import type {
  FeishuAccountConfig,
  FeishuConnectionState,
} from "@yep-anywhere/shared";
import type { FeishuCardActionEvent } from "./input-request.js";
import type { FeishuMessageMutation } from "./message-mutation.js";
import type { FeishuMessageApi } from "./normalization/types.js";
import type { FeishuSecretStore } from "./secret-store.js";
import type { FeishuStatusRegistry } from "./status.js";
import type {
  FeishuBotIdentity,
  FeishuTransport,
  FeishuTransportFactory,
} from "./transport.js";

export interface FeishuAccountConnectionOptions {
  account: FeishuAccountConfig;
  secretStore: FeishuSecretStore;
  statusRegistry: FeishuStatusRegistry;
  transportFactory: FeishuTransportFactory;
  onMessage(
    account: FeishuAccountConfig,
    event: unknown,
    botIdentity: FeishuBotIdentity | undefined,
    api: FeishuMessageApi | undefined,
  ): void | Promise<void>;
  onMessageMutation(
    account: FeishuAccountConfig,
    mutation: FeishuMessageMutation,
    api: FeishuMessageApi | undefined,
  ): void | Promise<void>;
  onCardAction(
    account: FeishuAccountConfig,
    event: FeishuCardActionEvent,
    api: FeishuMessageApi | undefined,
  ): void | Promise<void>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  random?(): number;
}

const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export class FeishuAccountConnection {
  readonly account: FeishuAccountConfig;
  private readonly options: FeishuAccountConnectionOptions;
  private transport?: FeishuTransport;
  private startPromise?: Promise<void>;
  private botIdentity?: FeishuBotIdentity;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private explicitlyStopped = false;
  private terminalErrorCode?: string;

  constructor(options: FeishuAccountConnectionOptions) {
    this.options = options;
    this.account = structuredClone(options.account);
    options.statusRegistry.ensure(this.account.id);
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.explicitlyStopped = false;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.terminalErrorCode = undefined;
    if (!this.account.enabled) {
      this.transition("disabled");
      return;
    }
    if (
      this.account.allowedUsers.length === 0 &&
      this.account.adminUsers.length === 0
    ) {
      this.transition("locked");
      return;
    }

    const appSecret = this.options.secretStore.resolve(this.account.secretRef);
    if (!appSecret) {
      this.transition("degraded", "SECRET_MISSING");
      return;
    }

    this.transition("connecting");
    const transport = this.options.transportFactory.create({
      account: this.account,
      appSecret,
      callbacks: {
        onBotIdentity: (identity) => {
          this.botIdentity = identity;
        },
        onReady: () => {
          this.resetRetryBackoff();
          this.transition("connected");
        },
        onReconnecting: () => this.transition("connecting"),
        onReconnected: () => {
          this.resetRetryBackoff();
          this.transition("connected");
        },
        onApiSuccess: () =>
          this.options.statusRegistry.markApiSuccess(this.account.id),
        onTerminalError: (errorCode) => {
          this.terminalErrorCode = errorCode;
          this.transition("degraded", errorCode);
          this.scheduleRetry();
        },
        onMessage: async (event, api) => {
          this.options.statusRegistry.markEvent(
            this.account.id,
            new Date(),
            "message",
          );
          if (isBotAuthoredEvent(event, this.botIdentity?.openId)) return;
          await this.options.onMessage(
            this.account,
            event,
            this.botIdentity,
            api,
          );
        },
        onMessageMutation: async (mutation, api) => {
          this.options.statusRegistry.markEvent(
            this.account.id,
            new Date(),
            "mutation",
          );
          await this.options.onMessageMutation(this.account, mutation, api);
        },
        onCardAction: async (event, api) => {
          this.options.statusRegistry.markEvent(
            this.account.id,
            new Date(),
            "card_action",
          );
          await this.options.onCardAction(this.account, event, api);
        },
      },
    });
    this.transport = transport;

    try {
      await transport.start();
    } catch {
      if (this.transport === transport) {
        this.transition(
          "degraded",
          this.terminalErrorCode ?? "WS_START_FAILED",
        );
        await transport.stop().catch(() => undefined);
        this.transport = undefined;
      }
      this.scheduleRetry();
    }
  }

  async stop(state: FeishuConnectionState = "stopped"): Promise<void> {
    this.explicitlyStopped = true;
    this.terminalErrorCode = undefined;
    this.resetRetryBackoff();
    const transport = this.transport;
    this.transport = undefined;
    await transport?.stop().catch(() => undefined);
    this.transition(state);
  }

  getContext():
    | {
        account: FeishuAccountConfig;
        botIdentity: FeishuBotIdentity;
        api: FeishuMessageApi;
      }
    | undefined {
    const api = this.transport?.getMessageApi?.();
    if (!this.botIdentity || !api) return undefined;
    return {
      account: structuredClone(this.account),
      botIdentity: structuredClone(this.botIdentity),
      api,
    };
  }

  private transition(state: FeishuConnectionState, errorCode?: string): void {
    this.options.statusRegistry.transition(this.account.id, state, {
      errorCode,
    });
  }

  private scheduleRetry(): void {
    if (this.explicitlyStopped || this.retryTimer) return;
    const baseMs = Math.max(
      1,
      this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    );
    const maxMs = Math.max(
      baseMs,
      this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    );
    const exponentialMs = Math.min(maxMs, baseMs * 2 ** this.retryAttempt);
    const jitterMs = Math.round(
      exponentialMs * 0.25 * (this.options.random?.() ?? Math.random()),
    );
    const delayMs = Math.min(maxMs, exponentialMs + jitterMs);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.restartAfterFailure();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private resetRetryBackoff(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
  }

  private async restartAfterFailure(): Promise<void> {
    if (this.explicitlyStopped) return;
    const transport = this.transport;
    this.transport = undefined;
    await transport?.stop().catch(() => undefined);
    if (this.explicitlyStopped) return;
    await this.start();
  }
}

export function isBotAuthoredEvent(
  event: unknown,
  botOpenId: string | undefined,
): boolean {
  if (!event || typeof event !== "object") return false;
  const sender = (event as { sender?: unknown }).sender;
  if (!sender || typeof sender !== "object") return false;
  const senderType = (sender as { sender_type?: unknown }).sender_type;
  if (senderType === "app" || senderType === "bot") return true;
  const senderId = (sender as { sender_id?: unknown }).sender_id;
  if (!senderId || typeof senderId !== "object" || !botOpenId) return false;
  return (senderId as { open_id?: unknown }).open_id === botOpenId;
}
