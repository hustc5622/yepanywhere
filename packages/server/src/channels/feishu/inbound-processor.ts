import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type {
  FeishuAccountConfig,
  FeishuSessionBinding,
  UploadedFile,
} from "@yep-anywhere/shared";
import { encodeProjectId } from "../../projects/paths.js";
import type { SessionCommandService } from "../../services/SessionCommandService.js";
import type { FeishuBindingStore } from "./binding-store.js";
import {
  FeishuInboundEventError,
  type FeishuInboundEventHeader,
  parseFeishuInboundEventHeader,
} from "./event-header.js";
import type {
  FeishuDurableInbox,
  FeishuInboxErrorCode,
  FeishuInboxRecord,
} from "./inbox.js";
import type { FeishuMediaDownloader } from "./media-downloader.js";
import { FeishuMessageNormalizer } from "./normalization/message-normalizer.js";
import type {
  FeishuAttachmentManifest,
  FeishuMessageApi,
  FeishuNormalizedInboundMessage,
} from "./normalization/types.js";
import { authorizeFeishuMessage } from "./policy.js";
import { FeishuScopeScheduler } from "./scheduler.js";
import { type FeishuScope, resolveFeishuScope } from "./scope.js";
import type { FeishuStatusRegistry } from "./status.js";
import type { FeishuBotIdentity } from "./transport.js";

export interface FeishuInboundProcessorOptions {
  sessionCommandService: SessionCommandService;
  bindingStore: FeishuBindingStore;
  inbox: FeishuDurableInbox;
  mediaDownloader?: FeishuMediaDownloader;
  normalizer?: FeishuMessageNormalizer;
  statusRegistry?: FeishuStatusRegistry;
  debounceMs?: number;
  onOutcome?(outcome: FeishuInboundOutcome): void | Promise<void>;
}

/** Minimal receive envelope. Service/lifecycle ownership is added in Batch 7. */
export interface FeishuInboundEnvelope {
  account: FeishuAccountConfig;
  event: unknown;
  botIdentity?: FeishuBotIdentity;
  api?: FeishuMessageApi;
}

/** Account-local recovery context without transport or output ownership. */
export interface FeishuConnectionContext {
  account: FeishuAccountConfig;
  botIdentity: FeishuBotIdentity;
  api: FeishuMessageApi;
}

export interface FeishuInboundAcceptResult {
  accepted: boolean;
  duplicate?: boolean;
  reason?: string;
  inboxKey?: string;
}

export interface FeishuInboundOutcome {
  type: "message";
  accountId: string;
  scopeKey: string;
  inboxKeys: string[];
  sessionId?: string;
}

interface AcceptedMessage {
  account: FeishuAccountConfig;
  api?: FeishuMessageApi;
  normalized: FeishuNormalizedInboundMessage;
  record: FeishuInboxRecord;
  scope: FeishuScope;
}

interface ResolvedProject {
  projectId: string;
  projectPath: string;
}

export class FeishuInboundProcessor {
  private readonly sessionCommandService: SessionCommandService;
  private readonly bindingStore: FeishuBindingStore;
  private readonly inbox: FeishuDurableInbox;
  private readonly mediaDownloader?: FeishuMediaDownloader;
  private readonly normalizer: FeishuMessageNormalizer;
  private readonly statusRegistry?: FeishuStatusRegistry;
  private readonly onOutcome?: FeishuInboundProcessorOptions["onOutcome"];
  private readonly scheduler: FeishuScopeScheduler<
    AcceptedMessage,
    FeishuInboundOutcome
  >;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queueDepthByAccount = new Map<string, number>();
  private shuttingDown = false;

  constructor(options: FeishuInboundProcessorOptions) {
    this.sessionCommandService = options.sessionCommandService;
    this.bindingStore = options.bindingStore;
    this.inbox = options.inbox;
    this.mediaDownloader = options.mediaDownloader;
    this.normalizer = options.normalizer ?? new FeishuMessageNormalizer();
    this.statusRegistry = options.statusRegistry;
    this.onOutcome = options.onOutcome;
    this.scheduler = new FeishuScopeScheduler({
      debounceMs: options.debounceMs,
      onMessageBatch: (scopeKey, messages) =>
        this.dispatchMessageBatch(scopeKey, messages),
    });
  }

  /**
   * Persist enough identity for dedup before returning to EventDispatcher.
   * Content expansion, downloads, and runtime calls continue asynchronously.
   */
  async accept(
    envelope: FeishuInboundEnvelope,
  ): Promise<FeishuInboundAcceptResult> {
    if (this.shuttingDown) {
      this.statusRegistry?.recordInbound(
        envelope.account.id,
        "rejected",
        "SHUTTING_DOWN",
      );
      return { accepted: false, reason: "SHUTTING_DOWN" };
    }
    if (!envelope.botIdentity) {
      this.statusRegistry?.recordInbound(
        envelope.account.id,
        "rejected",
        "BOT_IDENTITY_MISSING",
      );
      return { accepted: false, reason: "BOT_IDENTITY_MISSING" };
    }
    const botIdentity = envelope.botIdentity;

    let header: FeishuInboundEventHeader;
    try {
      header = parseFeishuInboundEventHeader(envelope.event, botIdentity);
    } catch (error) {
      if (error instanceof FeishuInboundEventError) {
        this.statusRegistry?.recordInbound(
          envelope.account.id,
          "rejected",
          error.code,
        );
        return { accepted: false, reason: error.code };
      }
      throw error;
    }
    const policy = authorizeFeishuMessage(envelope.account, {
      senderOpenId: header.senderOpenId,
      senderIsBot: header.senderType === "app" || header.senderType === "bot",
      botOpenId: envelope.botIdentity.openId,
      chatId: header.chatId,
      chatType: header.chatType,
      tenantKey: header.tenantKey,
      mentionsBot: header.mentionsBot,
    });
    if (!policy.allowed) {
      this.statusRegistry?.recordInbound(
        envelope.account.id,
        "rejected",
        policy.reason,
      );
      return { accepted: false, reason: policy.reason };
    }

    const received = await this.inbox.receive({
      accountId: envelope.account.id,
      eventId: header.eventId,
      eventType: "im.message.receive_v1",
      messageId: header.messageId,
    });
    this.statusRegistry?.recordInbound(
      envelope.account.id,
      received.duplicate ? "duplicate" : "accepted",
    );
    if (!received.duplicate || received.record.status === "received") {
      this.track(received.record, () =>
        this.normalizeAndSchedule({
          account: envelope.account,
          event: envelope.event,
          botIdentity,
          api: envelope.api,
          record: received.record,
        }),
      );
    }
    return {
      accepted: true,
      duplicate: received.duplicate,
      inboxKey: received.record.key,
    };
  }

  /** Reconcile persisted work without storing user content in the inbox. */
  async recover(
    getContext: (accountId: string) => FeishuConnectionContext | undefined,
  ): Promise<void> {
    for (const record of this.inbox.listRecoverable()) {
      const binding = record.scopeKey
        ? this.bindingStore.get(record.scopeKey)
        : undefined;
      if (record.status === "dispatched") {
        if (binding?.sessionId === record.sessionId) {
          await this.inbox.complete(record.key);
        } else {
          await this.failRecord(record.key, "RECOVERY_FAILED");
        }
        continue;
      }
      if (
        record.status === "dispatching" &&
        record.messageId &&
        binding?.lastInboundMessageId === record.messageId
      ) {
        await this.inbox.markDispatched(record.key, {
          sessionId: binding.sessionId,
        });
        await this.inbox.complete(record.key);
        continue;
      }
      if (record.status === "dispatching") {
        // `beginDispatch` is the durable, pre-side-effect ownership boundary.
        // Once a worker crosses it, a crash can happen either immediately
        // before the runtime call or after the runtime accepted the turn but
        // before Yep persisted the binding/receipt. Those two cases are not
        // distinguishable after restart. Re-fetching and dispatching here
        // could therefore execute the same Feishu message twice (including
        // when the runtime lives in an external process).
        //
        // A matching binding above is a durable receipt and can be restored.
        // Without that receipt, fail closed for explicit reconciliation; only
        // records that never crossed `beginDispatch` remain replayable.
        await this.failRecord(record.key, "RECOVERY_FAILED");
        continue;
      }
      const context = getContext(record.accountId);
      if (
        !context?.api.fetchMessageEvent ||
        !record.messageId ||
        this.inFlight.has(record.key)
      ) {
        continue;
      }
      try {
        const event = await context.api.fetchMessageEvent(record.messageId);
        const header = parseFeishuInboundEventHeader(
          event,
          context.botIdentity,
        );
        const policy = authorizeFeishuMessage(context.account, {
          senderOpenId: header.senderOpenId,
          senderIsBot:
            header.senderType === "app" || header.senderType === "bot",
          botOpenId: context.botIdentity.openId,
          chatId: header.chatId,
          chatType: header.chatType,
          tenantKey: header.tenantKey,
          mentionsBot: header.mentionsBot,
        });
        if (!policy.allowed) {
          await this.failRecord(record.key, "POLICY_DENIED");
          continue;
        }
        this.track(record, () =>
          this.normalizeAndSchedule({
            account: context.account,
            event,
            botIdentity: context.botIdentity,
            api: context.api,
            record,
          }),
        );
      } catch {
        await this.failRecord(record.key, "RECOVERY_FAILED");
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.scheduler.shutdown();
    await Promise.allSettled(this.inFlight.values());
    this.inFlight.clear();
    this.mediaDownloader?.stopRetentionCleanup();
  }

  private async normalizeAndSchedule(input: {
    account: FeishuAccountConfig;
    event: unknown;
    botIdentity: NonNullable<FeishuInboundEnvelope["botIdentity"]>;
    api?: FeishuMessageApi;
    record: FeishuInboxRecord;
  }): Promise<void> {
    const normalizationStartedAt = Date.now();
    let normalized: FeishuNormalizedInboundMessage;
    try {
      normalized = await this.normalizer.normalize({
        event: input.event,
        accountId: input.account.id,
        botIdentity: input.botIdentity,
        api: input.api,
      });
    } catch {
      this.statusRegistry?.recordNormalization(input.account.id, {
        durationMs: Date.now() - normalizationStartedAt,
        ...(isMergeForwardEvent(input.event) ? { forwardedItems: 0 } : {}),
        failed: true,
      });
      await this.failRecord(input.record.key, "NORMALIZATION_FAILED");
      return;
    }
    this.statusRegistry?.recordNormalization(input.account.id, {
      durationMs: Date.now() - normalizationStartedAt,
      forwardedItems: normalized.forwarded?.readItems,
    });

    let chatMode: "p2p" | "group" | "topic" | undefined;
    if (
      normalized.chatType === "group" &&
      !normalized.threadId &&
      normalized.rootId &&
      input.api?.getChatMode
    ) {
      chatMode = await input.api
        .getChatMode(normalized.chatId)
        .catch(() => undefined);
    }
    const scope = resolveFeishuScope({
      account: input.account,
      message: normalized,
      chatMode,
    });
    // Batch 6 owns normal inbound turns only. Commands and interactive output
    // are added atomically in Batch 7; never reinterpret a slash command as a
    // provider prompt while that authority is absent.
    if (isDeferredFeishuCommand(normalized.content)) {
      await this.failRecord(input.record.key, "DISPATCH_FAILED");
      return;
    }
    const accepted: AcceptedMessage = {
      account: input.account,
      api: input.api,
      normalized,
      record: input.record,
      scope,
    };
    this.adjustQueueDepth(input.account.id, 1);
    try {
      const outcome = await this.scheduler.enqueueMessage(scope.key, accepted);
      await this.onOutcome?.(outcome);
    } finally {
      this.adjustQueueDepth(input.account.id, -1);
    }
  }

  private async dispatchMessageBatch(
    scopeKey: string,
    batch: AcceptedMessage[],
  ): Promise<FeishuInboundOutcome> {
    // A transport redelivery can race while the durable row is still received.
    // The in-flight owner normally drops it before normalization, but keep this
    // boundary idempotent as well so one inbox key can never be rendered twice
    // into a batched provider prompt.
    const messages = [
      ...new Map(
        batch.map((message) => [message.record.key, message]),
      ).values(),
    ];
    try {
      for (const message of messages) {
        await this.inbox.beginDispatch(message.record.key, { scopeKey });
      }
      const first = messages[0];
      if (!first) throw new FeishuDispatchError("DISPATCH_FAILED");
      let binding = this.bindingStore.get(scopeKey);
      const project = await this.resolveProject(first.account, binding);
      const isFreshBinding = !binding;
      // A fresh Codex thread must receive its first prompt through one
      // SessionCommandService.start() dispatch. Persisting a create-only
      // binding first exposes an unmaterialized thread that cannot be resumed
      // if the queue path replaces its process before the first turn.
      //
      // Attachments still need a protected upload scope before Codex returns
      // the real thread ID. The durable inbox tempId is an opaque, path-safe
      // staging scope; it is never persisted as a Feishu session binding.
      binding ??= this.buildBinding(first, project, first.record.tempId);

      const lastMessage = messages.at(-1);

      const attachmentResults = await Promise.all(
        messages.map((message) =>
          this.downloadAttachments(message, binding as FeishuSessionBinding),
        ),
      );
      const attachments = attachmentResults.flatMap(
        (result) => result.attachments,
      );
      const prompt = formatMessageBatch(messages, attachmentResults);
      const origin = {
        createdBy: "channel" as const,
        originChannel: "feishu" as const,
        codexEventAccountId: first.account.id,
      };
      const body = {
        message: prompt,
        attachments,
        mode: binding.permissionMode,
        model: binding.model,
        reasoningEffort: binding.reasoningEffort,
        provider: "codex" as const,
        codexMcpMode: binding.codexMcpMode,
        tempId: messages[0]?.record.tempId,
      };
      const result = isFreshBinding
        ? await this.sessionCommandService.start({
            projectId: binding.projectId,
            origin,
            body,
            requireImmediate: true,
          })
        : await this.sessionCommandService.send({
            projectId: binding.projectId,
            sessionId: binding.sessionId,
            origin,
            body,
            requireImmediate: true,
          });
      if (!result.ok || result.status !== 200) {
        throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
      }
      const actualSessionId =
        readString(result.body.sessionId) ??
        (isFreshBinding ? undefined : binding.sessionId);
      if (!actualSessionId) {
        // A queued fresh start has no bindable thread ID yet. Fail closed
        // instead of persisting the internal attachment staging scope.
        throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
      }
      const runtimeProcessId = readString(result.body.processId);
      if (!runtimeProcessId) {
        // Channel dispatches need a concrete runtime generation before a
        // durable binding can serve as the at-most-once receipt.
        throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
      }
      binding = await this.bindingStore.upsert({
        ...binding,
        sessionId: actualSessionId,
        updatedAt: new Date().toISOString(),
        lastInboundMessageId: lastMessage?.normalized.messageId,
        lastInboundSenderOpenId: lastMessage?.normalized.senderId,
      });
      for (const message of messages) {
        await this.inbox.markDispatched(message.record.key, {
          sessionId: actualSessionId,
        });
        await this.inbox.complete(message.record.key);
      }
      return {
        type: "message",
        accountId: first.account.id,
        scopeKey,
        inboxKeys: messages.map((message) => message.record.key),
        sessionId: binding.sessionId,
      };
    } catch (error) {
      const code = toInboxErrorCode(error);
      await Promise.all(
        messages.map((message) => this.failRecord(message.record.key, code)),
      );
      throw error;
    }
  }

  private buildBinding(
    message: AcceptedMessage,
    project: ResolvedProject,
    sessionId: string,
  ): FeishuSessionBinding {
    const now = new Date().toISOString();
    return {
      version: 1,
      scopeKey: message.scope.key,
      accountId: message.account.id,
      chatId: message.scope.chatId,
      threadId: message.scope.threadId,
      projectId: project.projectId,
      projectPath: project.projectPath,
      sessionId,
      provider: "codex",
      permissionMode: message.account.defaultPermissionMode,
      model: message.account.defaultModel,
      reasoningEffort: message.account.defaultReasoningEffort,
      codexMcpMode: message.account.defaultCodexMcpMode,
      createdAt: now,
      updatedAt: now,
      lastInboundSenderOpenId: message.normalized.senderId,
    };
  }

  private async resolveProject(
    account: FeishuAccountConfig,
    binding: FeishuSessionBinding | undefined,
  ): Promise<ResolvedProject> {
    const candidate = binding?.projectPath ?? account.defaultProjectPath;
    if (!candidate) throw new FeishuDispatchError("PROJECT_NOT_ALLOWED");
    return this.resolveAllowedProject(account, candidate);
  }

  private async resolveAllowedProject(
    account: FeishuAccountConfig,
    candidate: string,
  ): Promise<ResolvedProject> {
    if (!isAbsolute(candidate) || account.allowedWorkspaceRoots.length === 0) {
      throw new FeishuDispatchError("PROJECT_NOT_ALLOWED");
    }
    let projectPath: string;
    try {
      projectPath = await realpath(candidate);
    } catch {
      throw new FeishuDispatchError("PROJECT_NOT_ALLOWED");
    }
    const allowedRoots = await Promise.all(
      account.allowedWorkspaceRoots.map((root) =>
        realpath(root).catch(() => null),
      ),
    );
    if (
      !allowedRoots.some((root) => root && isContainedPath(root, projectPath))
    ) {
      throw new FeishuDispatchError("PROJECT_NOT_ALLOWED");
    }
    return { projectId: encodeProjectId(projectPath), projectPath };
  }

  private async downloadAttachments(
    message: AcceptedMessage,
    binding: FeishuSessionBinding,
  ): Promise<{
    attachments: UploadedFile[];
    manifests: FeishuAttachmentManifest[];
    failureCodes: string[];
  }> {
    if (message.normalized.resources.length === 0) {
      return { attachments: [], manifests: [], failureCodes: [] };
    }
    if (!message.api || !this.mediaDownloader) {
      this.statusRegistry?.recordMedia(message.account.id, {
        succeeded: 0,
        failed: message.normalized.resources.length,
        bytes: 0,
      });
      return {
        attachments: [],
        manifests: [],
        failureCodes: ["DOWNLOAD_CAPABILITY_MISSING"],
      };
    }
    const result = await this.mediaDownloader.downloadAll({
      api: message.api,
      messageId: message.normalized.messageId,
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      taskId: message.record.tempId,
      resources: message.normalized.resources,
    });
    this.statusRegistry?.recordMedia(message.account.id, {
      succeeded: result.attachments.length,
      failed: result.failures.length,
      bytes: result.attachments.reduce(
        (total, attachment) => total + attachment.size,
        0,
      ),
    });
    return {
      attachments: result.attachments,
      manifests: result.manifests,
      failureCodes: result.failures.map((failure) => failure.code),
    };
  }

  private track(
    record: FeishuInboxRecord,
    operation: () => Promise<void>,
  ): void {
    if (this.inFlight.has(record.key)) return;
    // Defer invocation until after this key has an owner. Passing an already
    // started Promise here lets a duplicate normalize/schedule chain escape the
    // guard even though track() subsequently observes the existing owner.
    const tracked = Promise.resolve()
      .then(operation)
      .catch(async (error) => {
        await this.failRecord(record.key, toInboxErrorCode(error));
      })
      .finally(() => {
        this.inFlight.delete(record.key);
      });
    this.inFlight.set(record.key, tracked);
  }

  private async failRecord(
    key: string,
    code: FeishuInboxErrorCode,
  ): Promise<void> {
    const record = this.inbox.get(key);
    if (
      !record ||
      record.status === "completed" ||
      record.status === "failed"
    ) {
      return;
    }
    this.statusRegistry?.recordInbound(record.accountId, "failed", code);
    await this.inbox.fail(key, code);
  }

  private adjustQueueDepth(accountId: string, delta: number): void {
    const next = Math.max(
      0,
      (this.queueDepthByAccount.get(accountId) ?? 0) + delta,
    );
    if (next === 0) this.queueDepthByAccount.delete(accountId);
    else this.queueDepthByAccount.set(accountId, next);
    this.statusRegistry?.setScopeQueueDepth(accountId, next);
  }
}

class FeishuDispatchError extends Error {
  readonly code: FeishuInboxErrorCode;

  constructor(code: FeishuInboxErrorCode) {
    super(code);
    this.name = "FeishuDispatchError";
    this.code = code;
  }
}

function toInboxErrorCode(error: unknown): FeishuInboxErrorCode {
  return error instanceof FeishuDispatchError ? error.code : "DISPATCH_FAILED";
}

function isMergeForwardEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const message = (event as { message?: unknown }).message;
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { message_type?: unknown }).message_type === "merge_forward"
  );
}

function isDeferredFeishuCommand(content: string): boolean {
  return /^\s*\/[A-Za-z]/.test(content);
}

function formatMessageBatch(
  messages: AcceptedMessage[],
  downloads: Array<{
    attachments: UploadedFile[];
    manifests: FeishuAttachmentManifest[];
    failureCodes: string[];
  }>,
): string {
  return messages
    .map((message, index) => {
      const failures = downloads[index]?.failureCodes ?? [];
      const manifests = downloads[index]?.manifests ?? [];
      const suffix =
        failures.length > 0 ? `\n\n[附件导入失败：${failures.join(", ")}]` : "";
      const context = formatContextManifest(message.normalized);
      const attachmentManifest = formatFeishuAttachmentManifest(manifests);
      const body = `${message.normalized.content}${suffix}\n\n${context}${attachmentManifest}`;
      if (messages.length === 1) return body;
      return `## 飞书消息 ${index + 1}/${messages.length}\n\n${body}`;
    })
    .join("\n\n");
}

function formatContextManifest(
  message: FeishuNormalizedInboundMessage,
): string {
  const manifest = message.context;
  const range = manifest.timeRange
    ? `${new Date(manifest.timeRange.fromMs).toISOString()}..${new Date(manifest.timeRange.toMs).toISOString()}`
    : "unknown";
  return [
    "<feishu_context_manifest>",
    `mode: ${manifest.mode}`,
    `effective_mode: ${manifest.effectiveMode}`,
    `messages: ${manifest.messageCount}`,
    `time_range: ${range}`,
    `truncated_items: ${manifest.truncatedItems}`,
    `failed_items: ${manifest.failedItems}`,
    `attachments: ${manifest.attachmentCount}`,
    `operator: ${sanitizeManifestValue(
      manifest.operator.name ?? manifest.operator.id,
    )}`,
    `complete: ${manifest.complete}`,
    `warnings: ${manifest.warnings.length > 0 ? manifest.warnings.join(",") : "none"}`,
    "</feishu_context_manifest>",
  ].join("\n");
}

export function formatFeishuAttachmentManifest(
  manifests: FeishuAttachmentManifest[],
): string {
  if (manifests.length === 0) return "";
  return `\n\n<feishu_attachment_manifest>\n${manifests
    .flatMap((manifest) => {
      const name = sanitizeManifestValue(
        manifest.originalName ?? manifest.sanitizedName,
      );
      const entry = `- ${name} | kind=${manifest.kind} | mime=${manifest.detectedMime ?? manifest.declaredMime ?? "unknown"} | bytes=${manifest.sizeBytes} | sha256=${manifest.sha256} | ref=${manifest.localPathRef} | status=${manifest.status}`;
      if (!manifest.extraction) return [entry];
      const artifacts = manifest.extraction.artifacts.map(
        (artifact) =>
          `  artifact: kind=${artifact.kind} | mime=${artifact.mime} | bytes=${artifact.sizeBytes} | ref=${artifact.pathRef}`,
      );
      const warnings = manifest.extraction.warnings.map(
        (warning) => `  warning: ${sanitizeManifestValue(warning)}`,
      );
      return [
        entry,
        `  extraction: ${manifest.extraction.extractor}@${manifest.extraction.version} | truncated=${manifest.extraction.truncated}`,
        ...artifacts,
        ...warnings,
      ];
    })
    .join("\n")}\n</feishu_attachment_manifest>`;
}

function sanitizeManifestValue(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return " ";
    if (character === "|") return "¦";
    if (character === "<") return "‹";
    if (character === ">") return "›";
    return character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(sanitized).slice(0, 1_024).join("");
}

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
