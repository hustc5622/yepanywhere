import type {
  FeishuAccountConfig,
  FeishuAccountPublicView,
  FeishuAccountStatus,
  FeishuSecretRef,
} from "@yep-anywhere/shared";
import { FeishuAccountConfigStore } from "./config.js";
import type { FeishuCardActionEvent } from "./input-request.js";
import { LarkSdkFeishuTransportFactory } from "./lark-sdk-transport.js";
import { FeishuAccountConnection } from "./lifecycle.js";
import {
  type FeishuMessageMutationState,
  FeishuMessageMutationStore,
} from "./message-mutation-store.js";
import {
  FEISHU_MESSAGE_MUTATION_CAPABILITIES,
  type FeishuMessageMutation,
  observeFeishuMessageRevision,
} from "./message-mutation.js";
import type { FeishuMessageApi } from "./normalization/types.js";
import { FeishuSecretStore } from "./secret-store.js";
import { FeishuStatusRegistry } from "./status.js";
import type { FeishuTransportFactory } from "./transport.js";
import type { FeishuBotIdentity } from "./transport.js";

export interface FeishuInboundEnvelope {
  account: FeishuAccountConfig;
  event: unknown;
  botIdentity?: FeishuBotIdentity;
  api?: FeishuMessageApi;
}

export interface FeishuConnectionContext {
  account: FeishuAccountConfig;
  botIdentity: FeishuBotIdentity;
  api: FeishuMessageApi;
}

export interface FeishuMessageMutationEnvelope {
  account: FeishuAccountConfig;
  mutation: FeishuMessageMutation;
  state: FeishuMessageMutationState;
  api?: FeishuMessageApi;
}

export interface FeishuChannelServiceOptions {
  dataDir: string;
  configStore?: FeishuAccountConfigStore;
  secretStore?: FeishuSecretStore;
  statusRegistry?: FeishuStatusRegistry;
  mutationStore?: FeishuMessageMutationStore;
  transportFactory?: FeishuTransportFactory;
  onMessage?(input: FeishuInboundEnvelope): void | Promise<void>;
  onMessageMutation?(
    input: FeishuMessageMutationEnvelope,
  ): void | Promise<void>;
  onCardAction?(input: {
    account: FeishuAccountConfig;
    event: FeishuCardActionEvent;
    api?: FeishuMessageApi;
  }): void | Promise<void>;
  connectionRetry?: {
    baseMs?: number;
    maxMs?: number;
    random?(): number;
  };
}

export interface FeishuDoctorAccountResult {
  accountId: string;
  enabled: boolean;
  policyConfigured: boolean;
  secretConfigured: boolean;
  connectionState: FeishuAccountStatus["state"];
  checks: Array<{
    name: "policy" | "secret" | "connection";
    ok: boolean;
    code?: string;
  }>;
}

export interface FeishuDoctorResult {
  ok: boolean;
  initializationErrorCode?:
    | "STORE_INITIALIZATION_FAILED"
    | "CHANNEL_NOT_INITIALIZED"
    | "CHANNEL_STOPPED";
  accounts: FeishuDoctorAccountResult[];
}

export interface FeishuPermissionRequirements {
  accountId: string;
  capabilities: Array<{
    capability: string;
    scopes: string[];
    optional: boolean;
  }>;
  events: string[];
  callbacks: string[];
}

export interface FeishuDiagnosticReport {
  version: 1;
  generatedAt: string;
  operational: boolean;
  messageMutationCapabilities: typeof FEISHU_MESSAGE_MUTATION_CAPABILITIES;
  messageMutationPipeline: FeishuMessageMutationPipelineDiagnostic;
  doctor: FeishuDoctorResult;
  accounts: Array<{
    accountId: string;
    domain: FeishuAccountConfig["domain"];
    enabled: boolean;
    status?: FeishuAccountStatus;
    permissions: FeishuPermissionRequirements;
  }>;
}

export interface FeishuMessageMutationPipelineDiagnostic {
  version: 1;
  ingress: {
    recall: "official_event";
    reactions: "official_event";
    edit: "opportunistic_message_read_observation";
  };
  durableState: {
    operational: boolean;
    persistedEvents: number;
    contentStored: false;
  };
  accountStatus: "event_received_only";
  consumerCallback: "not_configured" | "configured_best_effort";
  deliveryGuarantee:
    | "durable_state_only"
    | "durable_state_then_best_effort_callback";
  canonicalTranscript: "not_wired" | "external_consumer_owned_unverified";
  uiProjection: "diagnostics_only" | "external_consumer_owned_unverified";
}

export class FeishuChannelService {
  readonly configStore: FeishuAccountConfigStore;
  readonly secretStore: FeishuSecretStore;
  readonly statusRegistry: FeishuStatusRegistry;
  readonly mutationStore: FeishuMessageMutationStore;
  private readonly transportFactory: FeishuTransportFactory;
  private readonly connectionRetry?: FeishuChannelServiceOptions["connectionRetry"];
  private onMessage?: FeishuChannelServiceOptions["onMessage"];
  private onMessageMutation?: FeishuChannelServiceOptions["onMessageMutation"];
  private onCardAction?: FeishuChannelServiceOptions["onCardAction"];
  private readonly connections = new Map<string, FeishuAccountConnection>();
  private initialized = false;
  private shuttingDown = false;
  private initializationErrorCode?: FeishuDoctorResult["initializationErrorCode"];
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(options: FeishuChannelServiceOptions) {
    this.configStore =
      options.configStore ??
      new FeishuAccountConfigStore({ dataDir: options.dataDir });
    this.secretStore =
      options.secretStore ??
      new FeishuSecretStore({ dataDir: options.dataDir });
    this.statusRegistry = options.statusRegistry ?? new FeishuStatusRegistry();
    this.mutationStore =
      options.mutationStore ??
      new FeishuMessageMutationStore({ dataDir: options.dataDir });
    this.transportFactory =
      options.transportFactory ??
      new LarkSdkFeishuTransportFactory({ dataDir: options.dataDir });
    this.connectionRetry = options.connectionRetry;
    this.onMessage = options.onMessage;
    this.onMessageMutation = options.onMessageMutation;
    this.onCardAction = options.onCardAction;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await Promise.all([
        this.configStore.initialize(),
        this.secretStore.initialize(),
        this.mutationStore.initialize(),
      ]);
      this.initialized = true;
      await this.reconcile();
    } catch {
      this.initializationErrorCode = "STORE_INITIALIZATION_FAILED";
    }
  }

  isOperational(): boolean {
    return (
      this.initialized && !this.shuttingDown && !this.initializationErrorCode
    );
  }

  async setInboundHandler(
    handler: FeishuChannelServiceOptions["onMessage"] | undefined,
  ): Promise<void> {
    this.onMessage = handler;
    if (this.initialized) await this.reconcile();
  }

  setMessageMutationHandler(
    handler: FeishuChannelServiceOptions["onMessageMutation"] | undefined,
  ): void {
    this.onMessageMutation = handler;
  }

  async setCardActionHandler(
    handler: FeishuChannelServiceOptions["onCardAction"] | undefined,
  ): Promise<void> {
    this.onCardAction = handler;
    if (this.initialized) await this.reconcile();
  }

  listAccounts(): FeishuAccountPublicView[] {
    this.assertOperational();
    return this.configStore
      .list()
      .map((account) =>
        toPublicAccount(account, this.secretStore.describe(account.secretRef)),
      );
  }

  listStatuses(): FeishuAccountStatus[] {
    return this.statusRegistry.list();
  }

  hasAccount(accountId: string): boolean {
    this.assertOperational();
    return Boolean(this.configStore.get(accountId));
  }

  getAccountSecretRef(accountId: string): FeishuSecretRef | undefined {
    this.assertOperational();
    return this.configStore.get(accountId)?.secretRef;
  }

  async upsertAccount(
    account: FeishuAccountConfig,
  ): Promise<FeishuAccountPublicView> {
    this.assertOperational();
    const saved = await this.configStore.upsert(account);
    await this.reconcile();
    return toPublicAccount(saved, this.secretStore.describe(saved.secretRef));
  }

  async removeAccount(accountId: string): Promise<boolean> {
    this.assertOperational();
    const removed = await this.configStore.remove(accountId);
    if (!removed) return false;
    await this.secretStore.remove(accountId);
    await this.reconcile();
    this.statusRegistry.remove(accountId);
    return true;
  }

  async setSecret(
    accountId: string,
    appSecret: string,
  ): Promise<FeishuAccountPublicView | undefined> {
    this.assertOperational();
    const account = this.configStore.get(accountId);
    if (!account) return undefined;
    const secretRef = await this.secretStore.set(accountId, appSecret);
    const saved = await this.configStore.upsert({ ...account, secretRef });
    await this.reconcile();
    return toPublicAccount(saved, this.secretStore.describe(secretRef));
  }

  async removeSecret(accountId: string): Promise<boolean> {
    this.assertOperational();
    const removed = await this.secretStore.remove(accountId);
    if (removed) await this.reconcile();
    return removed;
  }

  async connectAccount(accountId: string): Promise<boolean> {
    this.assertOperational();
    const account = this.configStore.get(accountId);
    if (!account?.enabled) return false;
    await this.reconcile();
    return true;
  }

  async disconnectAccount(accountId: string): Promise<boolean> {
    this.assertOperational();
    const connection = this.connections.get(accountId);
    if (!connection) return false;
    this.connections.delete(accountId);
    await connection.stop();
    return true;
  }

  async reconnectAccount(accountId: string): Promise<boolean> {
    this.assertOperational();
    if (!this.configStore.get(accountId)?.enabled) return false;
    const connection = this.connections.get(accountId);
    if (connection) {
      this.connections.delete(accountId);
      await connection.stop();
    }
    await this.reconcile();
    return true;
  }

  getPermissionRequirements(
    accountId: string,
  ): FeishuPermissionRequirements | undefined {
    this.assertOperational();
    if (!this.configStore.get(accountId)) return undefined;
    return {
      accountId,
      capabilities: [
        {
          capability: "message_receive",
          scopes: ["im:message"],
          optional: false,
        },
        {
          capability: "message_send",
          scopes: ["im:message:send_as_bot"],
          optional: false,
        },
        {
          capability: "message_read_and_forward_expand",
          scopes: ["im:message:readonly"],
          optional: false,
        },
        {
          capability: "topic_history",
          scopes: ["im:message.group_msg"],
          optional: true,
        },
        {
          capability: "message_reactions",
          scopes: ["im:message.reactions:read"],
          optional: true,
        },
        {
          capability: "message_resources",
          scopes: ["im:resource"],
          optional: false,
        },
        {
          capability: "chat_and_topic_metadata",
          scopes: ["im:chat"],
          optional: false,
        },
        {
          capability: "cardkit_create_update",
          scopes: ["cardkit:card:write"],
          optional: false,
        },
        {
          capability: "display_name_resolution",
          scopes: ["contact:user.base:readonly"],
          optional: true,
        },
      ],
      events: [
        "im.message.receive_v1",
        "im.message.recalled_v1",
        "im.message.reaction.created_v1",
        "im.message.reaction.deleted_v1",
      ],
      callbacks: ["card.action.trigger"],
    };
  }

  getConnectionContext(accountId: string): FeishuConnectionContext | undefined {
    return this.connections.get(accountId)?.getContext();
  }

  getMessageMutationState(
    accountId: string,
    messageId: string,
  ): FeishuMessageMutationState | undefined {
    this.assertOperational();
    return this.mutationStore.getState(accountId, messageId);
  }

  doctor(): FeishuDoctorResult {
    if (this.initializationErrorCode) {
      return {
        ok: false,
        initializationErrorCode: this.initializationErrorCode,
        accounts: [],
      };
    }
    if (!this.initialized || this.shuttingDown) {
      return {
        ok: false,
        initializationErrorCode: this.shuttingDown
          ? "CHANNEL_STOPPED"
          : "CHANNEL_NOT_INITIALIZED",
        accounts: [],
      };
    }
    const accounts = this.configStore.list().map((account) => {
      const policyConfigured =
        account.allowedUsers.length > 0 || account.adminUsers.length > 0;
      const secretConfigured = this.secretStore.describe(
        account.secretRef,
      ).configured;
      const status = this.statusRegistry.get(account.id);
      const connectionState = status?.state ?? "stopped";
      const connectionOk = !account.enabled || connectionState === "connected";
      return {
        accountId: account.id,
        enabled: account.enabled,
        policyConfigured,
        secretConfigured,
        connectionState,
        checks: [
          {
            name: "policy" as const,
            ok: policyConfigured,
            ...(!policyConfigured ? { code: "ALLOWLIST_EMPTY" } : {}),
          },
          {
            name: "secret" as const,
            ok: secretConfigured,
            ...(!secretConfigured ? { code: "SECRET_MISSING" } : {}),
          },
          {
            name: "connection" as const,
            ok: connectionOk,
            ...(!connectionOk
              ? { code: status?.lastErrorCode ?? "NOT_CONNECTED" }
              : {}),
          },
        ],
      };
    });
    return {
      ok: accounts.every((account) =>
        account.enabled ? account.checks.every((check) => check.ok) : true,
      ),
      accounts,
    };
  }

  diagnostics(now = new Date()): FeishuDiagnosticReport {
    const operational = this.isOperational();
    const doctor = this.doctor();
    const consumerConfigured = Boolean(this.onMessageMutation);
    const mutationStoreOperational = this.mutationStore.isOperational();
    return {
      version: 1,
      generatedAt: now.toISOString(),
      operational,
      messageMutationCapabilities: FEISHU_MESSAGE_MUTATION_CAPABILITIES,
      messageMutationPipeline: {
        version: 1,
        ingress: {
          recall: "official_event",
          reactions: "official_event",
          edit: "opportunistic_message_read_observation",
        },
        durableState: {
          operational: mutationStoreOperational,
          persistedEvents: mutationStoreOperational
            ? this.mutationStore.listEvents().length
            : 0,
          contentStored: false,
        },
        accountStatus: "event_received_only",
        consumerCallback: consumerConfigured
          ? "configured_best_effort"
          : "not_configured",
        deliveryGuarantee: consumerConfigured
          ? "durable_state_then_best_effort_callback"
          : "durable_state_only",
        canonicalTranscript: consumerConfigured
          ? "external_consumer_owned_unverified"
          : "not_wired",
        uiProjection: consumerConfigured
          ? "external_consumer_owned_unverified"
          : "diagnostics_only",
      },
      doctor,
      accounts: operational
        ? this.configStore.list().map((account) => ({
            accountId: account.id,
            domain: account.domain,
            enabled: account.enabled,
            status: this.statusRegistry.get(account.id),
            permissions: this.getPermissionRequirements(account.id) ?? {
              accountId: account.id,
              capabilities: [],
              events: [],
              callbacks: [],
            },
          }))
        : [],
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.reconcileChain.catch(() => undefined);
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.stop()));
  }

  private reconcile(): Promise<void> {
    const operation = this.reconcileChain.then(() => this.doReconcile());
    this.reconcileChain = operation.catch(() => undefined);
    return operation;
  }

  private async doReconcile(): Promise<void> {
    if (this.shuttingDown) return;
    const existing = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(existing.map((connection) => connection.stop()));
    if (this.shuttingDown) return;

    const accounts = this.configStore.list();
    const duplicateAppIds = findDuplicateEnabledAppIds(accounts);
    const starts: Promise<void>[] = [];
    for (const account of accounts) {
      if (account.enabled && duplicateAppIds.has(account.appId)) {
        this.statusRegistry.transition(account.id, "degraded", {
          errorCode: "DUPLICATE_APP_ID",
        });
        continue;
      }
      if (account.enabled && !this.onMessage) {
        this.statusRegistry.transition(account.id, "degraded", {
          errorCode: "INBOUND_HANDLER_MISSING",
        });
        continue;
      }
      const connection = new FeishuAccountConnection({
        account,
        secretStore: this.secretStore,
        statusRegistry: this.statusRegistry,
        transportFactory: this.transportFactory,
        onMessage: async (eventAccount, event, botIdentity, api) => {
          const revision = observeFeishuMessageRevision(event);
          if (revision) {
            await this.persistMessageMutation(eventAccount, revision, api);
          }
          await this.onMessage?.({
            account: eventAccount,
            event,
            botIdentity,
            ...(api ? { api } : {}),
          });
        },
        onMessageMutation: (eventAccount, mutation, api) =>
          this.persistMessageMutation(eventAccount, mutation, api),
        onCardAction: (eventAccount, event, api) =>
          this.onCardAction?.({
            account: eventAccount,
            event,
            ...(api ? { api } : {}),
          }),
        retryBaseMs: this.connectionRetry?.baseMs,
        retryMaxMs: this.connectionRetry?.maxMs,
        random: this.connectionRetry?.random,
      });
      this.connections.set(account.id, connection);
      starts.push(connection.start());
    }
    await Promise.all(starts);
  }

  private assertOperational(): void {
    if (
      !this.initialized ||
      this.shuttingDown ||
      this.initializationErrorCode
    ) {
      throw new Error("FeishuChannelService is not initialized");
    }
  }

  private async persistMessageMutation(
    account: FeishuAccountConfig,
    mutation: FeishuMessageMutation,
    api: FeishuMessageApi | undefined,
  ): Promise<void> {
    const result = await this.mutationStore.apply(account.id, mutation);
    if (!result.applied) return;
    await this.onMessageMutation?.({
      account,
      mutation,
      state: result.state,
      ...(api ? { api } : {}),
    });
  }
}

function findDuplicateEnabledAppIds(
  accounts: FeishuAccountConfig[],
): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const account of accounts) {
    if (!account.enabled) continue;
    if (seen.has(account.appId)) duplicates.add(account.appId);
    seen.add(account.appId);
  }
  return duplicates;
}

function toPublicAccount(
  account: FeishuAccountConfig,
  secret: FeishuAccountPublicView["secret"],
): FeishuAccountPublicView {
  const { secretRef: _secretRef, ...publicAccount } = account;
  return { ...publicAccount, secret };
}
