import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import type {
  FeishuAccountConfig,
  FeishuSessionBinding,
  UploadedFile,
} from "@yep-anywhere/shared";
import {
  containsSensitiveText,
  redactSensitivePublicText,
} from "../../codex-events/redaction.js";
import { encodeProjectId } from "../../projects/paths.js";
import type { CodexNativeControlRequest } from "../../sdk/providers/codex-controls.js";
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
import {
  type FeishuStreamingReplyTarget,
  hasFeishuInteractionApi,
} from "./outbound.js";
import { authorizeFeishuMessage } from "./policy.js";
import type {
  FeishuReplyManager,
  FeishuTurnReplyHandle,
  FeishuTurnReplyInput,
} from "./reply-manager.js";
import { FeishuScopeScheduler } from "./scheduler.js";
import { type FeishuScope, resolveFeishuScope } from "./scope.js";
import type {
  FeishuConnectionContext,
  FeishuInboundEnvelope,
} from "./service.js";
import type {
  FeishuSkillSelectionLease,
  FeishuSkillSelectionManager,
} from "./skill-selection-manager.js";
import type { FeishuStatusRegistry } from "./status.js";

export interface FeishuInboundProcessorOptions {
  sessionCommandService: SessionCommandService;
  bindingStore: FeishuBindingStore;
  inbox: FeishuDurableInbox;
  mediaDownloader?: FeishuMediaDownloader;
  normalizer?: FeishuMessageNormalizer;
  replyManager?: FeishuReplyManager;
  skillSelectionManager?: FeishuSkillSelectionManager;
  statusRegistry?: FeishuStatusRegistry;
  debounceMs?: number;
  onOutcome?(outcome: FeishuInboundOutcome): void | Promise<void>;
}

export interface FeishuInboundAcceptResult {
  accepted: boolean;
  duplicate?: boolean;
  reason?: string;
  inboxKey?: string;
}

export interface FeishuInboundOutcome {
  type: "message" | "command";
  accountId: string;
  scopeKey: string;
  inboxKeys: string[];
  sessionId?: string;
  command?: FeishuCommandName;
  text?: string;
}

export type FeishuCommandName =
  | "help"
  | "new"
  | "reset"
  | "status"
  | "stop"
  | "project"
  | "mode"
  | "doctor"
  | "codex";

interface AcceptedMessage {
  account: FeishuAccountConfig;
  api?: FeishuMessageApi;
  normalized: FeishuNormalizedInboundMessage;
  record: FeishuInboxRecord;
  scope: FeishuScope;
  role: "user" | "admin";
}

interface AcceptedInboundEvent {
  account: FeishuAccountConfig;
  api?: FeishuMessageApi;
  event: unknown;
  botIdentity: NonNullable<FeishuInboundEnvelope["botIdentity"]>;
  header: FeishuInboundEventHeader;
  record: FeishuInboxRecord;
  /** Recovery replays preserve one durable inbox row per dispatch task. */
  recovered?: boolean;
  role: "user" | "admin";
}

interface FeishuCommand {
  name: FeishuCommandName;
  argument?: string;
}

interface ResolvedProject {
  projectId: string;
  projectPath: string;
}

type FeishuCommandPermissionMode = "default" | "plan" | "acceptEdits";

export class FeishuInboundProcessor {
  private readonly sessionCommandService: SessionCommandService;
  private readonly bindingStore: FeishuBindingStore;
  private readonly inbox: FeishuDurableInbox;
  private readonly mediaDownloader?: FeishuMediaDownloader;
  private readonly normalizer: FeishuMessageNormalizer;
  private readonly replyManager?: FeishuReplyManager;
  private readonly skillSelectionManager?: FeishuSkillSelectionManager;
  private readonly statusRegistry?: FeishuStatusRegistry;
  private readonly onOutcome?: FeishuInboundProcessorOptions["onOutcome"];
  private readonly ingressScheduler: FeishuScopeScheduler<
    AcceptedInboundEvent,
    void
  >;
  private readonly scopeScheduler: FeishuScopeScheduler<AcceptedMessage, void>;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queueDepthByAccount = new Map<string, number>();
  private shuttingDown = false;

  constructor(options: FeishuInboundProcessorOptions) {
    this.sessionCommandService = options.sessionCommandService;
    this.bindingStore = options.bindingStore;
    this.inbox = options.inbox;
    this.mediaDownloader = options.mediaDownloader;
    this.normalizer = options.normalizer ?? new FeishuMessageNormalizer();
    this.replyManager = options.replyManager;
    this.skillSelectionManager = options.skillSelectionManager;
    this.statusRegistry = options.statusRegistry;
    this.onOutcome = options.onOutcome;
    this.ingressScheduler = new FeishuScopeScheduler({
      debounceMs: options.debounceMs,
      onMessageBatch: (_ingressKey, messages) =>
        this.normalizeAndDispatchBatch(messages),
    });
    this.scopeScheduler = new FeishuScopeScheduler({
      debounceMs: 0,
      onMessageBatch: (scopeKey, messages) =>
        this.dispatchMessageBatchWithOutcome(scopeKey, messages),
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
        this.enqueueInbound({
          account: envelope.account,
          event: envelope.event,
          botIdentity,
          header,
          api: envelope.api,
          record: received.record,
          role: policy.role,
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
      const context = getContext(record.accountId);
      if (record.status === "dispatched" && (!binding || !record.messageId)) {
        await this.failRecord(record.key, "RECOVERY_FAILED");
        continue;
      }
      if (
        record.status === "dispatched" ||
        (record.status === "dispatching" &&
          record.messageId &&
          binding?.lastInboundMessageId === record.messageId)
      ) {
        if (record.status === "dispatching") {
          await this.inbox.markDispatched(record.key, {
            sessionId: binding?.sessionId,
          });
        }
        const restored =
          binding && context && record.messageId && this.replyManager
            ? await this.replyManager.restoreTurn(
                createTurnReplyInput({
                  account: context.account,
                  api: context.api,
                  binding,
                  record,
                  replyToMessageId: record.messageId,
                  requesterOpenId: binding.lastInboundSenderOpenId,
                  allowedOperatorOpenIds: context.account.adminUsers,
                }),
              )
            : false;
        if (!restored && binding && context && this.replyManager) {
          await this.failRecord(record.key, "RECOVERY_FAILED");
        }
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
          this.enqueueInbound({
            account: context.account,
            event,
            botIdentity: context.botIdentity,
            header,
            api: context.api,
            record,
            recovered: true,
            role: policy.role,
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
    await this.ingressScheduler.shutdown();
    await Promise.allSettled(this.inFlight.values());
    await this.scopeScheduler.shutdown();
    this.inFlight.clear();
    this.mediaDownloader?.stopRetentionCleanup();
    this.skillSelectionManager?.shutdown();
  }

  /**
   * Enter the per-chat debounce window before relation expansion or any REST
   * lookup. A merge-forward can take materially longer to normalize than the
   * adjacent text that describes what to do with it; starting the window after
   * normalization lets the text overtake its material and creates two turns.
   */
  private async enqueueInbound(input: AcceptedInboundEvent): Promise<void> {
    this.adjustQueueDepth(input.account.id, 1);
    try {
      const ingressKey = resolveFeishuIngressKey(input.account, input.header);
      const commandHint = parseRawFeishuCommand(
        input.event,
        input.header,
        input.botIdentity.openId,
      );
      if (commandHint) {
        // Commands have a separate fast admission path. Their authoritative
        // scope and content are still established by normal normalization,
        // then the scope scheduler applies control priority.
        await this.normalizeAndDispatchBatch([input]);
      } else if (input.recovered) {
        // Recovery can admit many old rows in one event-loop turn. Keep them
        // serialized by scope, but do not reinterpret that restart-time
        // proximity as evidence that the original messages were one request.
        await this.ingressScheduler.enqueueControl(ingressKey, () =>
          this.normalizeAndDispatchBatch([input]),
        );
      } else {
        await this.ingressScheduler.enqueueMessage(ingressKey, input);
      }
    } finally {
      this.adjustQueueDepth(input.account.id, -1);
    }
  }

  private async normalizeAndDispatchBatch(
    batch: AcceptedInboundEvent[],
  ): Promise<void> {
    // Promise.all preserves receive order while preventing one expensive
    // merge-forward expansion from serially delaying unrelated normalization
    // work already admitted to this batch.
    const normalized = await Promise.all(
      batch.map((input) => this.normalizeInbound(input)),
    );
    const accepted = normalized.filter(
      (message): message is AcceptedMessage => message !== undefined,
    );

    // Submit every operation synchronously so the zero-delay scope scheduler
    // can batch regular messages by authoritative scope while control commands
    // retain their normal/high priority lane.
    await Promise.all(
      accepted.map((message) => {
        const command = parseFeishuCommand(message.normalized.content);
        return command
          ? this.scopeScheduler.enqueueControl(
              message.scope.key,
              () => this.dispatchCommandWithOutcome(message, command),
              { priority: command.name === "stop" ? "high" : "normal" },
            )
          : this.scopeScheduler.enqueueMessage(message.scope.key, message);
      }),
    );
  }

  private async normalizeInbound(
    input: AcceptedInboundEvent,
  ): Promise<AcceptedMessage | undefined> {
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
      return undefined;
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
      input.account.groupSessionMode === "thread-when-available"
    ) {
      if (!input.api?.getChatMode) {
        await this.failRecord(input.record.key, "NORMALIZATION_FAILED");
        return undefined;
      }
      try {
        chatMode = await input.api.getChatMode(normalized.chatId);
      } catch {
        // A root_id can be either a normal group reply or a topic root. Do not
        // guess and risk projecting a topic response into the main chat.
        await this.failRecord(input.record.key, "NORMALIZATION_FAILED");
        return undefined;
      }
    }
    const scope = resolveFeishuScope({
      account: input.account,
      message: normalized,
      chatMode,
    });
    return {
      account: input.account,
      api: input.api,
      normalized,
      record: input.record,
      scope,
      role: input.role,
    };
  }

  private async dispatchMessageBatchWithOutcome(
    scopeKey: string,
    messages: AcceptedMessage[],
  ): Promise<void> {
    try {
      const outcome = await this.dispatchMessageBatch(scopeKey, messages);
      await this.onOutcome?.(outcome);
    } catch {
      // dispatchMessageBatch owns the durable failure transition for every
      // member of the batch.
    }
  }

  private async dispatchCommandWithOutcome(
    message: AcceptedMessage,
    command: FeishuCommand,
  ): Promise<void> {
    try {
      const outcome = await this.dispatchCommand(message, command);
      await this.onOutcome?.(outcome);
    } catch {
      // dispatchCommand owns its durable failure transition.
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
    let replyHandle: FeishuTurnReplyHandle | undefined;
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
      const skillSelection = lastMessage
        ? this.skillSelectionManager?.peekForNextMessage({
            accountId: first.account.id,
            scopeKey,
            sessionId: binding.sessionId,
            requesterOpenId: lastMessage.normalized.senderId,
          })
        : undefined;
      if (this.replyManager && lastMessage) {
        replyHandle = await this.replyManager.startTurn(
          createTurnReplyInput({
            account: first.account,
            api: lastMessage.api,
            binding,
            record: first.record,
            records: messages.map((message) => message.record),
            replyToMessageId: lastMessage.normalized.messageId,
            requesterOpenId: lastMessage.normalized.senderId,
            deferSubscription: isFreshBinding,
            allowedOperatorOpenIds: [
              ...new Set([
                ...messages.map((message) => message.normalized.senderId),
                ...first.account.adminUsers,
              ]),
            ],
          }),
        );
      }

      const attachmentResults = await Promise.all(
        messages.map((message) =>
          this.downloadAttachments(message, binding as FeishuSessionBinding),
        ),
      );
      if (replyHandle && this.mediaDownloader) {
        const taskIds = [
          ...new Set(messages.map((message) => message.record.tempId)),
        ];
        replyHandle.addTerminalCleanup(async () => {
          await Promise.all(
            taskIds.map((taskId) =>
              this.mediaDownloader?.releaseTaskAudioStaging(taskId),
            ),
          );
        });
      }
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
        ...(skillSelection ? { codexInputs: skillSelection.codexInputs } : {}),
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
            allowSteer: false,
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
        // Channel dispatches need a concrete runtime generation before the
        // inbox can become dispatched or a one-shot Skill can be consumed.
        throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
      }
      await this.consumeSkillSelection(skillSelection);
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
      }
      if (replyHandle) {
        await replyHandle.dispatchAccepted(binding.sessionId, {
          processId: runtimeProcessId,
          restarted: result.body.restarted === true,
        });
      } else {
        for (const message of messages) {
          await this.inbox.complete(message.record.key);
        }
      }
      return {
        type: "message",
        accountId: first.account.id,
        scopeKey,
        inboxKeys: messages.map((message) => message.record.key),
        sessionId: binding.sessionId,
      };
    } catch (error) {
      await replyHandle?.dispatchFailed();
      const code = toInboxErrorCode(error);
      await Promise.all(
        messages.map((message) => this.failRecord(message.record.key, code)),
      );
      throw error;
    }
  }

  private async dispatchCommand(
    message: AcceptedMessage,
    command: FeishuCommand,
  ): Promise<FeishuInboundOutcome> {
    const { record, scope, account } = message;
    try {
      await this.inbox.beginDispatch(record.key, { scopeKey: scope.key });
      let binding = this.bindingStore.get(scope.key);
      let text: string;

      switch (command.name) {
        case "help": {
          text = FEISHU_COMMAND_HELP;
          break;
        }
        case "reset": {
          this.skillSelectionManager?.clearScope(scope.key);
          const removed = await this.bindingStore.remove(scope.key);
          binding = undefined;
          text = removed ? "当前会话绑定已解除。" : "当前没有会话绑定。";
          break;
        }
        case "status": {
          const snapshot = binding
            ? await this.sessionCommandService
                .getSessionSnapshot(binding.sessionId)
                .catch(() => null)
            : null;
          text = binding
            ? [
                `账号：${account.name} (${account.id})`,
                `Scope：${scope.kind}`,
                `项目：${basename(binding.projectPath)}`,
                `Session：${binding.sessionId}`,
                `Provider：${snapshot?.provider ?? binding.provider}`,
                `Model：${snapshot?.model ?? binding.model ?? "默认"}`,
                `Mode：${snapshot?.permissionMode ?? binding.permissionMode ?? account.defaultPermissionMode}`,
                `状态：${snapshot?.state ?? "未运行"}`,
              ].join("\n")
            : `账号：${account.name} (${account.id})\nScope：${scope.kind}\n当前没有会话绑定。`;
          break;
        }
        case "stop": {
          if (!binding) {
            text = "当前没有可停止的会话。";
            break;
          }
          const result = await this.sessionCommandService.interrupt(
            binding.sessionId,
          );
          if (result.ok) {
            await this.replyManager?.interruptSession(binding.sessionId);
          }
          text = result.ok ? "已请求停止当前任务。" : "当前任务未在运行。";
          break;
        }
        case "new": {
          const project = await this.resolveProject(account, binding);
          this.skillSelectionManager?.clearScope(scope.key);
          if (binding) {
            const previousSessionId = binding.sessionId;
            const released =
              await this.sessionCommandService.releaseSession(
                previousSessionId,
              );
            if (!released.ok) {
              throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
            }
            const removed = await this.bindingStore.removeIfSession(
              scope.key,
              previousSessionId,
            );
            if (!removed) {
              throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
            }
            binding = undefined;
          }
          binding = await this.createBinding(message, project);
          text = `已创建新会话：${binding.sessionId}`;
          break;
        }
        case "project": {
          if (!command.argument) {
            text = binding
              ? `当前项目：${basename(binding.projectPath)}\n使用 /project list 查看可选项目。`
              : `默认项目：${account.defaultProjectPath ? basename(account.defaultProjectPath) : "未配置"}\n使用 /project list 查看可选项目。`;
            break;
          }
          if (command.argument.toLowerCase() === "list") {
            const projects = await this.listConfiguredProjects(account);
            text =
              projects.length > 0
                ? `可用项目：\n${projects.map((project) => `- ${project.name}`).join("\n")}`
                : "当前账号没有可用项目。";
            break;
          }
          const useMatch = command.argument.match(/^use\s+(.+)$/i);
          let project: ResolvedProject | undefined;
          if (useMatch?.[1]) {
            project = await this.resolveConfiguredProject(
              account,
              useMatch[1].trim(),
            );
            if (!project) {
              text =
                "项目名称不存在或不唯一。使用 /project list 查看可选项目。";
              break;
            }
          } else {
            if (message.role !== "admin") {
              text =
                "只有管理员可以使用绝对路径切换项目。请使用 /project use <name>。";
              break;
            }
            project = await this.resolveAllowedProject(
              account,
              command.argument,
            );
          }
          this.skillSelectionManager?.clearScope(scope.key);
          if (binding) {
            const previousSessionId = binding.sessionId;
            const released =
              await this.sessionCommandService.releaseSession(
                previousSessionId,
              );
            if (!released.ok) {
              throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
            }
            const removed = await this.bindingStore.removeIfSession(
              scope.key,
              previousSessionId,
            );
            if (!removed) {
              throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
            }
            binding = undefined;
          }
          binding = await this.createBinding(message, project);
          text = `已切换项目：${basename(binding.projectPath)}`;
          break;
        }
        case "mode": {
          const mode = parseCommandPermissionMode(command.argument);
          if (!binding) {
            text = "当前没有会话绑定。请先发送任务或使用 /new。";
            break;
          }
          if (!mode) {
            text = "用法：/mode <default|plan|acceptEdits>";
            break;
          }
          const result = await this.sessionCommandService.setPermissionMode(
            binding.sessionId,
            mode,
          );
          if (!result.ok && result.status !== 404) {
            text = "Permission mode 切换失败，请在 Yep 中查看状态。";
            break;
          }
          const confirmedMode = result.ok
            ? (parseCommandPermissionMode(
                readString(result.body.permissionMode),
              ) ?? mode)
            : mode;
          binding = { ...binding, permissionMode: confirmedMode };
          text = `Mode 已切换为：${confirmedMode}${result.ok ? "" : "（下次启动生效）"}`;
          break;
        }
        case "doctor": {
          const runtime = await this.sessionCommandService
            .getRuntimeStatus()
            .catch(() => null);
          text = [
            "飞书连接：正常（已收到当前事件）",
            `账号策略：${account.allowedUsers.length + account.adminUsers.length > 0 ? "已配置" : "未配置"}`,
            `Workspace：${account.allowedWorkspaceRoots.length > 0 ? "已限制" : "未配置"}`,
            `CardKit：${hasFeishuInteractionApi(message.api) ? "可用" : "不可用，将降级"}`,
            `Yep Runtime：${runtime ? `可用，active=${runtime.activeWorkers}，queue=${runtime.queueLength}` : "不可用"}`,
            `Session：${binding?.sessionId ?? "未绑定"}`,
          ].join("\n");
          break;
        }
        case "codex": {
          text = await this.dispatchCodexCommand(
            message,
            binding,
            command.argument,
          );
          break;
        }
      }

      if (binding) {
        binding = await this.bindingStore.upsert({
          ...binding,
          updatedAt: new Date().toISOString(),
          lastInboundMessageId: record.messageId,
          lastInboundSenderOpenId: message.normalized.senderId,
        });
      }
      await this.inbox.markDispatched(record.key, {
        sessionId: binding?.sessionId,
      });
      await this.inbox.complete(record.key);
      await this.replyManager?.sendCommandResult(
        message.api,
        createReplyTarget(message.scope, message.normalized.messageId),
        text,
      );
      return {
        type: "command",
        command: command.name,
        accountId: account.id,
        scopeKey: scope.key,
        inboxKeys: [record.key],
        sessionId: binding?.sessionId,
        text,
      };
    } catch (error) {
      await this.failRecord(record.key, toInboxErrorCode(error));
      throw error;
    }
  }

  private async dispatchCodexCommand(
    message: AcceptedMessage,
    binding: FeishuSessionBinding | undefined,
    argument: string | undefined,
  ): Promise<string> {
    const command = parseFeishuCodexCommand(argument);
    if (command.kind === "help") return FEISHU_CODEX_COMMAND_HELP;
    if (command.kind === "blocked") return command.message;
    if (command.kind === "invalid") return command.message;
    if (!binding) {
      return "当前没有 Codex 会话绑定。请先发送任务或使用 /new。";
    }

    const result = await this.sessionCommandService.executeCodexControl({
      sessionId: binding.sessionId,
      request: command.request,
    });
    if (!result.ok)
      return formatCodexControlFailure(result.status, result.body);
    if (
      command.request.control === "skills/list" &&
      this.skillSelectionManager
    ) {
      const presentation = await this.skillSelectionManager.presentPicker(
        {
          accountId: message.account.id,
          scopeKey: message.scope.key,
          sessionId: binding.sessionId,
          chatId: message.scope.chatId,
          threadId: message.scope.threadId,
          replyToMessageId: message.normalized.messageId,
          requesterOpenId: message.normalized.senderId,
          api: message.api,
        },
        result.body.data,
      );
      return presentation.text;
    }
    return formatCodexControlSuccess(command.request, result.body.data);
  }

  private async consumeSkillSelection(
    selection: FeishuSkillSelectionLease | undefined,
  ): Promise<void> {
    if (!selection) return;
    await this.skillSelectionManager?.consume(selection);
  }

  private async createBinding(
    message: AcceptedMessage,
    project: ResolvedProject,
  ): Promise<FeishuSessionBinding> {
    const result = await this.sessionCommandService.create({
      projectId: project.projectId,
      origin: {
        createdBy: "channel",
        originChannel: "feishu",
        codexEventAccountId: message.account.id,
      },
      body: {
        provider: "codex",
        mode: message.account.defaultPermissionMode,
        model: message.account.defaultModel,
        reasoningEffort: message.account.defaultReasoningEffort,
        codexMcpMode: message.account.defaultCodexMcpMode,
      },
      requireImmediate: true,
    });
    const sessionId = result.ok ? readString(result.body.sessionId) : undefined;
    const processId = result.ok ? readString(result.body.processId) : undefined;
    if (!result.ok || result.status !== 200 || !sessionId || !processId) {
      if (sessionId) {
        await this.sessionCommandService
          .releaseSession(sessionId)
          .catch(() => undefined);
      }
      throw new FeishuDispatchError("SESSION_COMMAND_FAILED");
    }
    try {
      return await this.bindingStore.upsert(
        this.buildBinding(message, project, sessionId),
      );
    } catch (error) {
      await this.sessionCommandService
        .releaseSession(sessionId)
        .catch(() => undefined);
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

  private async listConfiguredProjects(
    account: FeishuAccountConfig,
  ): Promise<Array<ResolvedProject & { name: string }>> {
    const candidates = [
      account.defaultProjectPath,
      ...account.allowedWorkspaceRoots,
    ].filter((candidate): candidate is string => Boolean(candidate));
    const projects: Array<ResolvedProject & { name: string }> = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      try {
        const project = await this.resolveAllowedProject(account, candidate);
        if (seen.has(project.projectPath)) continue;
        seen.add(project.projectPath);
        projects.push({ ...project, name: basename(project.projectPath) });
      } catch {
        // Invalid configured paths are omitted and surfaced by /doctor.
      }
    }
    return projects;
  }

  private async resolveConfiguredProject(
    account: FeishuAccountConfig,
    name: string,
  ): Promise<ResolvedProject | undefined> {
    const normalized = name.toLocaleLowerCase();
    const matches = (await this.listConfiguredProjects(account)).filter(
      (project) => project.name.toLocaleLowerCase() === normalized,
    );
    return matches.length === 1 ? matches[0] : undefined;
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

function resolveFeishuIngressKey(
  account: Pick<FeishuAccountConfig, "id" | "groupSessionMode">,
  header: FeishuInboundEventHeader,
): string {
  if (header.chatType === "p2p") {
    return `${account.id}:p2p:${header.chatId}`;
  }
  if (account.groupSessionMode === "thread-when-available" && header.threadId) {
    return `${account.id}:thread:${header.chatId}:${header.threadId}`;
  }
  // A root_id is not necessarily a topic/thread ID. Batch ambiguous roots at
  // chat granularity, then split by resolveFeishuScope after normalization.
  return `${account.id}:group-ingress:${header.chatId}`;
}

function parseRawFeishuCommand(
  event: unknown,
  header: Pick<FeishuInboundEventHeader, "messageType">,
  botOpenId: string,
): FeishuCommand | undefined {
  if (header.messageType !== "text" || !event || typeof event !== "object") {
    return undefined;
  }
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const rawMessage = message as {
    content?: unknown;
    mentions?: unknown;
  };
  if (typeof rawMessage.content !== "string") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage.content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const parsedText = (parsed as { text?: unknown }).text;
  if (typeof parsedText !== "string") return undefined;
  let text = parsedText;

  if (Array.isArray(rawMessage.mentions)) {
    for (const value of rawMessage.mentions) {
      if (!value || typeof value !== "object") continue;
      const mention = value as { id?: unknown; key?: unknown };
      const id =
        mention.id && typeof mention.id === "object"
          ? (mention.id as { open_id?: unknown })
          : undefined;
      if (id?.open_id === botOpenId && typeof mention.key === "string") {
        text = text.replaceAll(mention.key, "");
      }
    }
  }
  return parseFeishuCommand(text);
}

function parseFeishuCommand(content: string): FeishuCommand | undefined {
  const trimmed = content.trim();
  const match = trimmed.match(
    /^\/(help|new|reset|status|stop|project|mode|doctor|codex)(?:\s+([\s\S]+))?$/i,
  );
  if (!match?.[1]) return undefined;
  return {
    name: match[1].toLowerCase() as FeishuCommandName,
    argument: match[2]?.trim() || undefined,
  };
}

type ParsedFeishuCodexCommand =
  | { kind: "help" }
  | { kind: "invoke"; request: CodexNativeControlRequest }
  | { kind: "blocked"; message: string }
  | { kind: "invalid"; message: string };

function parseFeishuCodexCommand(
  argument: string | undefined,
): ParsedFeishuCodexCommand {
  const value = argument?.trim();
  if (!value || /^help$/i.test(value)) return { kind: "help" };
  if (/^skills$/i.test(value)) {
    return { kind: "invoke", request: { control: "skills/list" } };
  }
  if (/^compact$/i.test(value)) {
    return { kind: "invoke", request: { control: "thread/compact/start" } };
  }
  if (/^review$/i.test(value)) {
    return {
      kind: "invoke",
      request: {
        control: "review/start",
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      },
    };
  }
  if (/^goal$/i.test(value)) {
    return { kind: "invoke", request: { control: "thread/goal/get" } };
  }
  if (/^goal\s+clear$/i.test(value)) {
    return { kind: "invoke", request: { control: "thread/goal/clear" } };
  }
  const goalSet = value.match(/^goal\s+set(?:\s+([\s\S]+))?$/i);
  if (goalSet) {
    const objective = goalSet[1]?.trim();
    if (!objective) {
      return {
        kind: "invalid",
        message: "用法：/codex goal set <objective>",
      };
    }
    if (containsSensitiveText(objective)) {
      return {
        kind: "invalid",
        message: "Goal objective 疑似包含敏感信息，未提交。",
      };
    }
    if (objective.length > MAX_CODEX_GOAL_OBJECTIVE_CHARS) {
      return {
        kind: "invalid",
        message: `Goal objective 不能超过 ${MAX_CODEX_GOAL_OBJECTIVE_CHARS} 个字符。`,
      };
    }
    return {
      kind: "invoke",
      request: { control: "thread/goal/set", objective },
    };
  }
  if (/^shell(?:\s|$)/i.test(value)) {
    return {
      kind: "blocked",
      message:
        "已阻止 /codex shell：thread/shellCommand 会在 sandbox 外执行，飞书渠道不开放此高风险能力。",
    };
  }
  if (/^(?:ps|stop|clean)(?:\s|$)/i.test(value)) {
    return {
      kind: "blocked",
      message:
        "已阻止该后台终端命令：当前 Codex session 未启用 experimental API。中断当前 turn 请使用顶层 /stop。",
    };
  }
  return {
    kind: "blocked",
    message: `未知或未开放的 /codex 子命令。\n\n${FEISHU_CODEX_COMMAND_HELP}`,
  };
}

function parseCommandPermissionMode(
  value: string | undefined,
): FeishuCommandPermissionMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "default" || normalized === "plan") return normalized;
  return normalized === "acceptedits" ? "acceptEdits" : undefined;
}

const FEISHU_COMMAND_HELP = [
  "可用命令：",
  "/status — 当前项目、Session、模型与状态",
  "/new — 创建新 Session，保留旧历史",
  "/reset — 解除当前 Scope 的绑定",
  "/stop — 停止当前任务",
  "/project list — 查看允许的项目",
  "/project use <name> — 切换到允许的项目",
  "/mode <default|plan|acceptEdits> — 切换权限模式",
  "/codex <subcommand> — Skills、Review、Compact 与 Goal 安全控制",
  "/doctor — 检查连接、权限、卡片和 Runtime",
  "安全限制：项目必须在账号 allowlist 内；审批仅限任务发起者或管理员；不支持 bypassPermissions。",
].join("\n");

const FEISHU_CODEX_COMMAND_HELP = [
  "Codex 安全命令：",
  "/codex skills — 选择一个 Skill 应用于下一条正常消息",
  "/codex review — inline 审查未提交变更",
  "/codex compact — 压缩当前上下文",
  "/codex goal — 查看当前 Goal",
  "/codex goal set <objective> — 设置 Goal",
  "/codex goal clear — 清除 Goal",
  "安全限制：/codex shell 与后台终端 ps/stop/clean 不开放；中断当前 turn 使用顶层 /stop。",
].join("\n");

const MAX_CODEX_SKILLS = 12;
const MAX_CODEX_SKILL_NAME_CHARS = 80;
const MAX_CODEX_SKILL_DESCRIPTION_CHARS = 160;
const MAX_CODEX_GOAL_OBJECTIVE_CHARS = 4_000;
const MAX_CODEX_COMMAND_OUTPUT_CHARS = 3_500;

function formatCodexControlSuccess(
  request: CodexNativeControlRequest,
  data: unknown,
): string {
  switch (request.control) {
    case "skills/list":
      return formatCodexSkills(data);
    case "review/start":
      return "已启动对未提交变更的 inline review。";
    case "thread/compact/start":
      return "已请求压缩当前 Codex 上下文。";
    case "thread/goal/get":
    case "thread/goal/set":
      return formatCodexGoal(data, request.control === "thread/goal/set");
    case "thread/goal/clear": {
      const cleared = readBoolean(readRecord(data)?.cleared);
      return cleared === false
        ? "当前没有可清除的 Goal。"
        : "已清除当前 Goal。";
    }
    case "thread/shellCommand":
    case "thread/backgroundTerminals/list":
    case "thread/backgroundTerminals/terminate":
    case "thread/backgroundTerminals/clean":
      return "该 Codex 控制未在飞书渠道开放。";
  }
}

function formatCodexSkills(data: unknown): string {
  const root = readRecord(data);
  const entries = Array.isArray(root?.data) ? root.data : [];
  const skills: Array<{ name: string; description: string }> = [];
  for (const entryValue of entries) {
    const entry = readRecord(entryValue);
    if (!Array.isArray(entry?.skills)) continue;
    for (const skillValue of entry.skills) {
      const skill = readRecord(skillValue);
      const name = sanitizeCodexPublicText(
        readString(skill?.name) ?? "",
        MAX_CODEX_SKILL_NAME_CHARS,
      );
      if (!name) continue;
      skills.push({
        name,
        description: sanitizeCodexPublicText(
          readString(skill?.description) ?? "",
          MAX_CODEX_SKILL_DESCRIPTION_CHARS,
        ),
      });
    }
  }
  if (skills.length === 0) return "当前没有可用 Skills。";

  const visible = skills.slice(0, MAX_CODEX_SKILLS);
  const lines = visible.map(({ name, description }) =>
    description ? `- ${name} — ${description}` : `- ${name}`,
  );
  if (skills.length > visible.length) {
    lines.push(`…另有 ${skills.length - visible.length} 项未显示。`);
  }
  return boundCodexCommandOutput(
    [`可用 Skills（${skills.length}）：`, ...lines].join("\n"),
  );
}

function formatCodexGoal(data: unknown, updated: boolean): string {
  const root = readRecord(data);
  const goal = readRecord(root?.goal);
  if (!goal) return updated ? "Goal 更新成功。" : "当前没有 Goal。";

  const objective = sanitizeCodexPublicText(
    readString(goal.objective) ?? "",
    1_000,
  );
  const status = sanitizeCodexPublicText(
    readString(goal.status) ?? "unknown",
    40,
  );
  const tokenBudget = readSafeNumber(goal.tokenBudget);
  const tokensUsed = readSafeNumber(goal.tokensUsed);
  const lines = [updated ? "Goal 已更新：" : "当前 Goal："];
  if (objective) lines.push(`目标：${objective}`);
  lines.push(`状态：${status}`);
  if (tokensUsed !== undefined) lines.push(`已用 tokens：${tokensUsed}`);
  if (tokenBudget !== undefined) lines.push(`Token budget：${tokenBudget}`);
  return boundCodexCommandOutput(lines.join("\n"));
}

function formatCodexControlFailure(
  status: number,
  body: Record<string, unknown>,
): string {
  switch (readString(body.code)) {
    case "unsupported_provider":
      return "当前绑定不是可执行原生控制的 Codex app-server session。";
    case "unsupported_method":
      return "当前 Codex app-server 版本不支持该控制。";
    case "experimental_api_disabled":
      return "该控制需要 experimental API；当前 session 已安全禁用。";
    case "not_ready":
      return "当前 Codex session 尚未就绪，请稍后重试。";
    case "invalid_request":
      return "Codex 拒绝了无效的控制参数，请检查命令用法。";
    case "provider_error":
      return readBoolean(body.retryable)
        ? "Codex 暂时无法完成该控制，请稍后重试。"
        : "Codex 无法完成该控制，请在 Yep 中查看诊断。";
    default:
      return status === 404
        ? "当前 Codex session 没有活动进程，请先发送任务或使用 /new。"
        : "Codex 控制执行失败，请在 Yep 中查看诊断。";
  }
}

function sanitizeCodexPublicText(value: string, maxChars: number): string {
  const withoutPaths = redactSensitivePublicText(value)
    .replace(/file:\/\/\/[^\s]+/gi, "[path]")
    .replace(/(^|[\s([{"'`=])\/(?:[^/\s]+\/)+(?:[^\s)\]}"'`,;]*)/g, "$1[path]")
    .replace(/(^|[\s([{"'`=])~\/(?:[^\s]+)/g, "$1[path]")
    .replace(/(^|[\s([{"'`=])[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "$1[path]");
  const withoutControls = Array.from(withoutPaths, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");
  return boundText(withoutControls.replace(/\s+/g, " ").trim(), maxChars);
}

function boundCodexCommandOutput(value: string): string {
  return boundText(value, MAX_CODEX_COMMAND_OUTPUT_CHARS);
}

function boundText(value: string, maxChars: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  return `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readSafeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
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
    `operator: ${manifest.operator.name ?? manifest.operator.id}`,
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
      const entry = `- ${manifest.originalName ?? manifest.sanitizedName} | kind=${manifest.kind} | mime=${manifest.detectedMime ?? manifest.declaredMime ?? "unknown"} | bytes=${manifest.sizeBytes} | sha256=${manifest.sha256} | ref=${manifest.localPathRef} | status=${manifest.status}`;
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
  return sanitizeCodexPublicText(value, 1_024);
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

function createTurnReplyInput(input: {
  account: FeishuAccountConfig;
  api?: FeishuMessageApi;
  binding: FeishuSessionBinding;
  record: FeishuInboxRecord;
  records?: FeishuInboxRecord[];
  replyToMessageId?: string;
  requesterOpenId?: string;
  deferSubscription?: boolean;
  allowedOperatorOpenIds?: string[];
}): FeishuTurnReplyInput {
  const replyToMessageId =
    input.replyToMessageId ??
    input.record.messageId ??
    input.binding.lastInboundMessageId;
  if (!replyToMessageId) {
    throw new FeishuDispatchError("RECOVERY_FAILED");
  }
  return {
    accountId: input.account.id,
    scopeKey: input.binding.scopeKey,
    projectId: input.binding.projectId,
    sessionId: input.binding.sessionId,
    tempId: input.record.tempId,
    inboxKeys: (input.records ?? [input.record]).map((record) => record.key),
    replyMode: input.account.replyMode,
    api: input.api,
    threadId: input.binding.threadId,
    target: createReplyTarget(
      {
        chatId: input.binding.chatId,
        threadId: input.binding.threadId,
      },
      replyToMessageId,
    ),
    requesterOpenId: input.requesterOpenId,
    deferSubscription: input.deferSubscription,
    allowedOperatorOpenIds: [
      ...new Set([
        ...(input.requesterOpenId ? [input.requesterOpenId] : []),
        ...(input.allowedOperatorOpenIds ?? input.account.adminUsers),
      ]),
    ],
  };
}

function createReplyTarget(
  scope: Pick<FeishuScope, "chatId" | "threadId">,
  replyToMessageId: string,
): FeishuStreamingReplyTarget {
  return {
    chatId: scope.chatId,
    replyToMessageId,
    replyInThread: Boolean(scope.threadId),
  };
}
