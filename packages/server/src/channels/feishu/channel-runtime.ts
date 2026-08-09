import { join } from "node:path";
import type { SessionCommandService } from "../../services/SessionCommandService.js";
import { UploadManager } from "../../uploads/manager.js";
import type { EventBus } from "../../watcher/index.js";
import { FeishuBindingStore } from "./binding-store.js";
import { FeishuInboundProcessor } from "./inbound-processor.js";
import { FeishuDurableInbox } from "./inbox.js";
import { FeishuInteractionManager } from "./interaction-manager.js";
import { FeishuMediaDownloader } from "./media-downloader.js";
import { FeishuOperationStore } from "./operation-store.js";
import { FeishuReplyManager } from "./reply-manager.js";
import { FeishuChannelService } from "./service.js";
import { FeishuSkillSelectionManager } from "./skill-selection-manager.js";

export type FeishuChannelRuntimeDiagnosticCode =
  | "PERSISTENCE_INITIALIZATION_FAILED"
  | "BINDING_REMAP_FAILED"
  | "CHANNEL_STORE_INITIALIZATION_FAILED"
  | "RECOVERY_FAILED";

export interface FeishuChannelRuntimeOptions {
  dataDir: string;
  maxUploadSizeBytes?: number;
  /** Explicit externally reachable Yep base URL; local/default URLs are rejected downstream. */
  publicBaseUrl?: string;
  service?: FeishuChannelService;
  bindingStore?: FeishuBindingStore;
  inbox?: FeishuDurableInbox;
  operationStore?: FeishuOperationStore;
  onDiagnostic?(code: FeishuChannelRuntimeDiagnosticCode): void;
}

export interface FeishuChannelRuntimePrepareResult {
  persistenceReady: boolean;
  errorCode?: "PERSISTENCE_INITIALIZATION_FAILED";
}

export interface FeishuChannelRuntimeStartResult {
  persistenceReady: boolean;
  serviceOperational: boolean;
  errorCode?:
    | "PERSISTENCE_INITIALIZATION_FAILED"
    | "CHANNEL_STORE_INITIALIZATION_FAILED"
    | "RECOVERY_FAILED";
}

/**
 * Owns the Feishu adapter graph without owning SessionCommandService or the
 * central InteractionBroker. Persistence is prepared before runtime event
 * replay; network consumers start only after every handler is installed.
 */
export class FeishuChannelRuntime {
  readonly service: FeishuChannelService;
  readonly bindingStore: FeishuBindingStore;
  readonly inbox: FeishuDurableInbox;
  readonly operationStore: FeishuOperationStore;

  private readonly dataDir: string;
  private readonly maxUploadSizeBytes?: number;
  private readonly publicBaseUrl?: string;
  private readonly onDiagnostic?: FeishuChannelRuntimeOptions["onDiagnostic"];
  private prepareTask?: Promise<FeishuChannelRuntimePrepareResult>;
  private prepareResult?: FeishuChannelRuntimePrepareResult;
  private startTask?: Promise<FeishuChannelRuntimeStartResult>;
  private startResult?: FeishuChannelRuntimeStartResult;
  private eventBus?: EventBus;
  private unsubscribeSessionRemap?: () => void;
  private bindingRemapChain: Promise<void> = Promise.resolve();
  private inboundProcessor?: FeishuInboundProcessor;
  private replyManager?: FeishuReplyManager;
  private interactionManager?: FeishuInteractionManager;
  private shuttingDown = false;
  private shutdownTask?: Promise<void>;

  constructor(options: FeishuChannelRuntimeOptions) {
    this.dataDir = options.dataDir;
    this.service =
      options.service ?? new FeishuChannelService({ dataDir: options.dataDir });
    this.bindingStore =
      options.bindingStore ??
      new FeishuBindingStore({ dataDir: options.dataDir });
    this.inbox =
      options.inbox ?? new FeishuDurableInbox({ dataDir: options.dataDir });
    this.operationStore =
      options.operationStore ??
      new FeishuOperationStore({ dataDir: options.dataDir });
    this.maxUploadSizeBytes = options.maxUploadSizeBytes;
    this.publicBaseUrl = options.publicBaseUrl;
    this.onDiagnostic = options.onDiagnostic;
  }

  prepare(eventBus: EventBus): Promise<FeishuChannelRuntimePrepareResult> {
    if (this.shuttingDown) {
      return Promise.resolve({
        persistenceReady: false,
        errorCode: "PERSISTENCE_INITIALIZATION_FAILED",
      });
    }
    if (this.prepareResult) return Promise.resolve(this.prepareResult);
    if (this.eventBus && this.eventBus !== eventBus) {
      throw new Error("Feishu channel runtime EventBus changed");
    }
    this.eventBus = eventBus;
    if (!this.prepareTask) {
      this.prepareTask = this.doPrepare(eventBus).then((result) => {
        this.prepareResult = result;
        return result;
      });
    }
    return this.prepareTask;
  }

  start(input: {
    eventBus: EventBus;
    sessionCommandService: SessionCommandService;
  }): Promise<FeishuChannelRuntimeStartResult> {
    if (this.startResult) return Promise.resolve(this.startResult);
    if (this.shuttingDown) {
      return Promise.resolve({
        persistenceReady: false,
        serviceOperational: false,
        errorCode: "PERSISTENCE_INITIALIZATION_FAILED",
      });
    }
    if (!this.startTask) {
      this.startTask = this.doStart(input).then((result) => {
        this.startResult = result;
        return result;
      });
    }
    return this.startTask;
  }

  isOperational(): boolean {
    return (
      !this.shuttingDown &&
      this.startResult?.serviceOperational === true &&
      this.service.isOperational()
    );
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shuttingDown = true;
    this.unsubscribeSessionRemap?.();
    this.unsubscribeSessionRemap = undefined;
    const task = this.doShutdown();
    this.shutdownTask = task;
    return task;
  }

  private async doPrepare(
    eventBus: EventBus,
  ): Promise<FeishuChannelRuntimePrepareResult> {
    try {
      await Promise.all([
        this.bindingStore.initialize(),
        this.inbox.initialize(),
        this.operationStore.initialize(),
      ]);
    } catch {
      this.emitDiagnostic("PERSISTENCE_INITIALIZATION_FAILED");
      return {
        persistenceReady: false,
        errorCode: "PERSISTENCE_INITIALIZATION_FAILED",
      };
    }

    this.unsubscribeSessionRemap = eventBus.subscribe((event) => {
      if (event.type !== "session-id-changed" || this.shuttingDown) return;
      this.bindingRemapChain = this.bindingRemapChain
        .catch(() => undefined)
        .then(() =>
          this.bindingStore.remapSessionId(
            event.oldSessionId,
            event.newSessionId,
          ),
        )
        .then(() => undefined)
        .catch(() => {
          this.emitDiagnostic("BINDING_REMAP_FAILED");
        });
    });
    return { persistenceReady: true };
  }

  private async doStart(input: {
    eventBus: EventBus;
    sessionCommandService: SessionCommandService;
  }): Promise<FeishuChannelRuntimeStartResult> {
    const prepared = await this.prepare(input.eventBus);
    if (!prepared.persistenceReady) {
      await this.service.initialize();
      const serviceError = this.service.doctor().initializationErrorCode;
      if (serviceError) {
        this.emitDiagnostic("CHANNEL_STORE_INITIALIZATION_FAILED");
      }
      return {
        ...prepared,
        serviceOperational: false,
      };
    }

    const uploadManager = new UploadManager({
      uploadsDir: join(this.dataDir, "uploads"),
      ...(this.maxUploadSizeBytes !== undefined
        ? { maxUploadSizeBytes: this.maxUploadSizeBytes }
        : {}),
    });
    const interactionManager = new FeishuInteractionManager({
      sessionCommandService: input.sessionCommandService,
      operationStore: this.operationStore,
      statusRegistry: this.service.statusRegistry,
    });
    const skillSelectionManager = new FeishuSkillSelectionManager({
      getBinding: (scopeKey) => this.bindingStore.get(scopeKey),
    });
    const replyManager = new FeishuReplyManager({
      sessionCommandService: input.sessionCommandService,
      inbox: this.inbox,
      interactionManager,
      statusRegistry: this.service.statusRegistry,
      uploadManager,
      ...(this.publicBaseUrl ? { publicBaseUrl: this.publicBaseUrl } : {}),
    });
    const mediaDownloader = new FeishuMediaDownloader({ uploadManager });
    const inboundProcessor = new FeishuInboundProcessor({
      sessionCommandService: input.sessionCommandService,
      bindingStore: this.bindingStore,
      inbox: this.inbox,
      mediaDownloader,
      replyManager,
      skillSelectionManager,
      statusRegistry: this.service.statusRegistry,
    });
    this.interactionManager = interactionManager;
    this.replyManager = replyManager;
    this.inboundProcessor = inboundProcessor;

    await this.service.setInboundHandler(async (envelope) => {
      await inboundProcessor.accept(envelope);
    });
    await this.service.setCardActionHandler(async (envelope) => {
      const skillAction = await skillSelectionManager.acceptCardAction({
        accountId: envelope.account.id,
        event: envelope.event,
        api: envelope.api,
        adminUsers: envelope.account.adminUsers,
      });
      if (skillAction !== "ignored") return;
      await interactionManager.acceptCardAction({
        accountId: envelope.account.id,
        event: envelope.event,
        api: envelope.api,
      });
    });

    await this.service.initialize();
    const doctor = this.service.doctor();
    if (doctor.initializationErrorCode) {
      this.emitDiagnostic("CHANNEL_STORE_INITIALIZATION_FAILED");
      await this.service.shutdown();
      await this.shutdownAdapters();
      return {
        persistenceReady: true,
        serviceOperational: false,
        errorCode: "CHANNEL_STORE_INITIALIZATION_FAILED",
      };
    }

    if (this.service.listAccounts().some((account) => account.enabled)) {
      await mediaDownloader.startRetentionCleanup();
    }

    try {
      await inboundProcessor.recover((accountId) =>
        this.service.getConnectionContext(accountId),
      );
      await interactionManager.recover((accountId) => {
        const context = this.service.getConnectionContext(accountId);
        return context
          ? {
              api: context.api,
              adminUsers: context.account.adminUsers,
            }
          : undefined;
      });
    } catch {
      this.emitDiagnostic("RECOVERY_FAILED");
      await this.service.shutdown();
      await this.shutdownAdapters();
      return {
        persistenceReady: true,
        serviceOperational: false,
        errorCode: "RECOVERY_FAILED",
      };
    }

    return {
      persistenceReady: true,
      serviceOperational: this.service.isOperational(),
    };
  }

  private async doShutdown(): Promise<void> {
    await this.prepareTask?.catch(() => undefined);
    await this.startTask?.catch(() => undefined);
    await this.bindingRemapChain.catch(() => undefined);
    await this.service.shutdown();
    await this.shutdownAdapters();
  }

  private async shutdownAdapters(): Promise<void> {
    await this.inboundProcessor?.shutdown();
    await this.replyManager?.shutdown();
    await this.interactionManager?.shutdown();
  }

  private emitDiagnostic(code: FeishuChannelRuntimeDiagnosticCode): void {
    this.onDiagnostic?.(code);
  }
}
