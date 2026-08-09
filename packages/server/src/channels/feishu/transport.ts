import type { FeishuAccountConfig } from "@yep-anywhere/shared";
import type { FeishuMessageMutation } from "./message-mutation.js";
import type { FeishuMessageApi } from "./normalization/types.js";

export interface FeishuBotIdentity {
  openId: string;
  name?: string;
}

export interface FeishuTransportCallbacks {
  onBotIdentity(identity: FeishuBotIdentity): void;
  onReady(): void;
  onReconnecting(): void;
  onReconnected(): void;
  onApiSuccess(): void;
  onTerminalError(errorCode: string): void;
  onMessage(event: unknown, api?: FeishuMessageApi): void | Promise<void>;
  onMessageMutation(
    event: FeishuMessageMutation,
    api?: FeishuMessageApi,
  ): void | Promise<void>;
}

export interface FeishuTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMessageApi?(): FeishuMessageApi;
}

export interface FeishuTransportFactoryInput {
  account: FeishuAccountConfig;
  appSecret: string;
  callbacks: FeishuTransportCallbacks;
}

export interface FeishuTransportFactory {
  create(input: FeishuTransportFactoryInput): FeishuTransport;
}
