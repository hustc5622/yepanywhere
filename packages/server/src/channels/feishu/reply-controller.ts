import { createHash } from "node:crypto";
import type {
  CodexRetryStatus,
  GeneratedArtifactBlockReason,
  GeneratedArtifactManifest,
  GeneratedArtifactWarning,
} from "@yep-anywhere/shared";
import { isGeneratedArtifactDownloadUrl } from "@yep-anywhere/shared";
import {
  extractTextDelta,
  extractTextForFinalRender,
  getMessageContent,
} from "../../augments/index.js";
import {
  type CanonicalCodexError,
  classifyCodexError,
} from "../../codex/error-taxonomy.js";
import { validateGeneratedArtifactPayload } from "../../uploads/index.js";
import { inspectCodexGeneratedImage } from "./generated-artifact.js";
import {
  FEISHU_STREAM_ACTIVITY_ELEMENT_IDS,
  FEISHU_STREAM_ANSWER_ELEMENT_ID,
  FEISHU_STREAM_ARTIFACTS_ELEMENT_ID,
  FEISHU_STREAM_PROGRESS_ELEMENT_ID,
  FEISHU_STREAM_PROGRESS_ELEMENT_IDS,
  FEISHU_STREAM_STATUS_ELEMENT_ID,
  FEISHU_STREAM_TOOLS_ELEMENT_ID,
  type FeishuArtifactDeliveryIdentity,
  type FeishuOutboundApi,
  type FeishuStreamingReplyTarget,
  type FeishuStreamingSectionElementId,
} from "./outbound.js";
import {
  type FeishuCardProjectionMode,
  FeishuRichCardProjection,
} from "./rich-card-projection.js";
import type { YepDeepLinkAvailability } from "./yep-deep-link.js";

export type FeishuReplyState =
  | "created"
  | "acknowledged"
  | "queued"
  | "retrying"
  | "streaming"
  | "waiting_input"
  | "completed"
  | "interrupted"
  | "failed"
  | "degraded_text";

export interface FeishuReplyControllerOptions {
  api?: FeishuOutboundApi;
  target: FeishuStreamingReplyTarget;
  replyMode: "card" | "markdown" | "text";
  tempId: string;
  throttleMs?: number;
  maxCardChars?: number;
  maxTextChars?: number;
  getYepDeepLink?(): YepDeepLinkAvailability;
  /** Resolve only a server-materialized opaque ref; never receives provider paths. */
  readGeneratedArtifact?(
    artifact: GeneratedArtifactManifest,
  ): Promise<Uint8Array>;
  /** Supplies path-free account/session scope for stable artifact delivery. */
  getArtifactDeliveryScope?(): { accountId: string; sessionId: string };
  onMetric?(
    event:
      | "card_updated"
      | "card_degraded"
      | "first_feedback"
      | "first_token"
      | "completed",
    durationMs?: number,
  ): void;
  onTerminal?(
    state: FeishuReplyState,
    outcome: "completed" | "interrupted" | "failed",
  ): void | Promise<void>;
}

const DEFAULT_THROTTLE_MS = 750;
const DEFAULT_MAX_CARD_CHARS = 28_000;
const DEFAULT_MAX_TEXT_CHARS = 3_500;

interface VisibleCardElement {
  elementId: FeishuStreamingSectionElementId;
  content: string;
}

interface CorrelatedTurnTerminal {
  outcome: "completed" | "interrupted" | "failed";
  failure?: unknown;
}

const FEISHU_CODEX_ERROR_COPY = {
  CODEX_NO_ROLLOUT: {
    category: "no_rollout",
    retryable: true,
    publicMessage: "当前会话尚未准备好，任务无法启动。",
    nextAction: "请新建 Session 后重试。",
  },
  CODEX_OVERLOADED: {
    category: "overloaded",
    retryable: true,
    publicMessage: "Codex 当前繁忙，暂时无法处理请求。",
    nextAction: "请稍后重试。",
  },
  CODEX_AUTH_REQUIRED: {
    category: "auth",
    retryable: false,
    publicMessage: "Codex 登录状态已失效或尚未完成。",
    nextAction: "请先在 Yep 中重新登录 Codex，再重试。",
  },
  CODEX_QUOTA_EXCEEDED: {
    category: "quota",
    retryable: true,
    publicMessage: "Codex 使用额度或上下文预算已达到上限。",
    nextAction: "请检查额度，或在限制重置后重试。",
  },
  CODEX_PERMISSION_DENIED: {
    category: "permission",
    retryable: false,
    publicMessage: "该操作被权限策略拒绝。",
    nextAction: "请检查审批与权限设置，或调整任务。",
  },
  CODEX_ATTACHMENT_FAILED: {
    category: "attachment",
    retryable: false,
    publicMessage: "附件无法读取或处理。",
    nextAction: "请重新上传，或改用受支持的格式和大小。",
  },
  CODEX_BRIDGE_UNAVAILABLE: {
    category: "bridge",
    retryable: true,
    publicMessage: "Yep 无法重新连接到当前 Session 所属的 Codex 进程。",
    nextAction: "请检查 Codex bridge 后重试。",
  },
  CODEX_PROCESS_EXITED: {
    category: "process_exit",
    retryable: true,
    publicMessage: "Codex 进程在任务完成前意外退出。",
    nextAction: "请重试；若问题持续，请在 Yep 中查看诊断信息。",
  },
  CODEX_SANDBOX_DENIED: {
    category: "sandbox",
    retryable: false,
    publicMessage: "该操作被运行时沙箱拦截。",
    nextAction: "请检查沙箱设置，或改用允许的路径和操作。",
  },
  CODEX_UNKNOWN: {
    category: "unknown",
    retryable: false,
    publicMessage: "Codex 遇到未分类错误，任务未能完成。",
    nextAction: "请重试；若问题持续，请在 Yep 中查看诊断信息。",
  },
} as const satisfies Record<
  CanonicalCodexError["code"],
  {
    category: CanonicalCodexError["category"];
    retryable: boolean;
    publicMessage: string;
    nextAction: string;
  }
>;

export class FeishuReplyController {
  private readonly options: FeishuReplyControllerOptions;
  private readonly throttleMs: number;
  private readonly maxCardChars: number;
  private readonly maxTextChars: number;
  private stateValue: FeishuReplyState = "created";
  private statusText = "正在处理…";
  private answer = "";
  private cardOffset = 0;
  private cardId?: string;
  private sequence = 0;
  private lastRenderHash?: string;
  private lastRenderCardId?: string;
  private readonly lastSectionRenderHashes = new Map<string, string>();
  private readonly createdSectionElementIds =
    new Set<FeishuStreamingSectionElementId>();
  private dispatchConfirmed = false;
  private sawTurnMessage = false;
  private readonly preDispatchEvents: Array<[string, unknown]> = [];
  private clientUserMessageId?: string;
  private expectedTurnId?: string;
  private readonly pendingTurnTerminals = new Map<
    string,
    CorrelatedTurnTerminal
  >();
  private runtimeGeneration = 0;
  private turnStarted = false;
  private terminal = false;
  private degraded = false;
  private started?: Promise<void>;
  private updateTimer?: ReturnType<typeof setTimeout>;
  private eventChain: Promise<void> = Promise.resolve();
  private outputChain: Promise<void> = Promise.resolve();
  private readonly startedAt = Date.now();
  private firstFeedbackRecorded = false;
  private firstTokenRecorded = false;
  private failure?: CanonicalCodexError;
  private readonly projection = new FeishuRichCardProjection();
  /** IDs enter this set only after the native Feishu send succeeds. */
  private readonly generatedArtifactEffectIds = new Set<string>();
  private readonly generatedArtifactWarningIds = new Set<string>();
  private readonly generatedArtifactInFlightIds = new Set<string>();
  private readonly generatedArtifactRetryableIds = new Set<string>();

  constructor(options: FeishuReplyControllerOptions) {
    this.options = options;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.maxCardChars = options.maxCardChars ?? DEFAULT_MAX_CARD_CHARS;
    this.maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  }

  get state(): FeishuReplyState {
    return this.stateValue;
  }

  get text(): string {
    return this.answer;
  }

  start(): Promise<void> {
    if (!this.started) this.started = this.startOutput();
    return this.started;
  }

  dispatchAccepted(): void {
    if (this.terminal) return;
    this.dispatchConfirmed = true;
    for (const [eventType, data] of this.preDispatchEvents.splice(0)) {
      void this.handleRuntimeEvent(eventType, data);
    }
  }

  /**
   * Move a not-yet-confirmed reply onto a replacement runtime process.
   *
   * A planned Supervisor restart closes the old process before the replacement
   * process accepts the queued turn. Events already queued by that old process
   * must not become terminal evidence for the replacement turn.
   */
  activateRuntimeGeneration(generation: number): void {
    if (
      !Number.isSafeInteger(generation) ||
      generation <= this.runtimeGeneration ||
      this.terminal
    ) {
      return;
    }
    this.runtimeGeneration = generation;
    if (this.dispatchConfirmed) return;
    this.sawTurnMessage = false;
    this.turnStarted = false;
    this.clientUserMessageId = undefined;
    this.expectedTurnId = undefined;
    this.pendingTurnTerminals.clear();
    this.preDispatchEvents.length = 0;
  }

  dispatchFailed(): Promise<void> {
    return this.finalize("failed");
  }

  interrupt(): Promise<void> {
    return this.finalize("interrupted");
  }

  handleRuntimeEvent(
    eventType: string,
    data: unknown,
    runtimeGeneration = this.runtimeGeneration,
  ): Promise<void> {
    this.eventChain = this.eventChain
      .then(() => {
        if (runtimeGeneration !== this.runtimeGeneration) return;
        return this.processRuntimeEvent(eventType, data);
      })
      .catch(() => undefined);
    return this.eventChain;
  }

  async detach(): Promise<void> {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    await this.eventChain;
    await this.outputChain;
  }

  private async startOutput(): Promise<void> {
    if (!this.options.api) {
      if (this.stateValue === "created") this.stateValue = "acknowledged";
      return;
    }
    if (this.options.replyMode === "text") {
      try {
        await this.options.api.sendTextReply(
          this.options.target,
          "已接收，正在处理…",
        );
        this.markFirstFeedback();
      } catch {
        // The terminal result will attempt the same text fallback later.
      }
      if (this.stateValue === "created") this.stateValue = "acknowledged";
      return;
    }
    try {
      const initialContent = this.initialCardContent(this.statusText, "");
      const reply = await this.options.api.createStreamingReply(
        this.options.target,
        initialContent,
      );
      this.cardId = reply.cardId;
      this.rememberInitialCardRender(reply.cardId, initialContent);
      this.markFirstFeedback();
      if (this.stateValue === "created") this.stateValue = "acknowledged";
    } catch {
      await this.degradeToText();
    }
  }

  private async processRuntimeEvent(
    eventType: string,
    data: unknown,
  ): Promise<void> {
    if (this.terminal) return;
    if (!this.dispatchConfirmed) {
      if (eventType === "message") {
        const message = objectValue(data);
        if (
          message?.type === "user" &&
          stringValue(message.tempId) === this.options.tempId
        ) {
          this.sawTurnMessage = true;
        }
      }
      // A provider can fail (for example, thread/resume can reject) before it
      // echoes the user message. Keep terminal events that race with the send
      // response so dispatchAccepted() can settle the acknowledged Feishu turn.
      if (
        this.sawTurnMessage ||
        isPreDispatchTerminalEvent(eventType, data) ||
        isPreDispatchRetryEvent(eventType, data)
      ) {
        this.preDispatchEvents.push([eventType, data]);
      }
      return;
    }
    if (eventType === "message") {
      await this.processMessage(data);
      return;
    }
    if (eventType === "status") {
      const status = objectValue(data);
      const state = stringValue(status?.state);
      if (state === "waiting-input" && this.turnStarted) {
        this.setState("waiting_input", "等待你在飞书或 Yep 中审批/回答…");
      } else if (state === "in-turn" && this.turnStarted) {
        this.setState("streaming", "Codex 正在处理…");
      } else if (state === "hold" && this.turnStarted) {
        this.setState("waiting_input", "任务已暂停…");
      } else if (state === "idle" && this.turnStarted && this.expectedTurnId) {
        // A queued fallback cannot establish expectedTurnId until its own
        // provider echo. Therefore an earlier turn's idle is ignored, while a
        // later idle after accepted correlation remains a safe compatibility
        // terminal for runtimes that omit a result message.
        await this.finalize("completed");
      }
      return;
    }
    if (eventType === "error") {
      this.captureFailure(data);
      await this.finalize("failed");
      return;
    }
    if (eventType === "complete") {
      // Stream completion has no turn identity. A successful Codex turn must
      // first produce a correlated result or turn_complete; otherwise treat
      // the closed stream as a runtime failure, never as B's success.
      await this.finalize("failed");
    }
  }

  private async processMessage(data: unknown): Promise<void> {
    const message = objectValue(data);
    if (!message) return;
    if (message.isSubagent === true) {
      if (this.turnStarted) {
        this.projection.observe(message);
        this.scheduleUpdate();
      }
      return;
    }
    if (message.type === "error") {
      const turnId = runtimeTurnId(message);
      if (turnId) {
        await this.acceptTurnTerminal(turnId, {
          outcome: "failed",
          failure: message.codexError ?? message.error ?? message,
        });
      } else {
        // An unscoped SDK error is process-fatal, not a normal prior-turn
        // terminal. Once dispatch is accepted it safely fails the live reply.
        this.captureFailure(message.codexError ?? message.error ?? message);
        await this.finalize("failed");
      }
      return;
    }
    if (message.type === "user" && !containsToolResult(message)) {
      const correlated = await this.observeTurnUser(message);
      if (correlated && this.turnStarted && !this.terminal) {
        this.projection.observe(message);
        this.scheduleUpdate();
      }
      return;
    }

    // A replacement process can finish before the post-dispatch subscription
    // attaches. In that case its snapshot is already idle and the only
    // correlated terminal evidence available through replay is the matching
    // user echo followed by the provider result. Never accept a result before
    // that echo has established this controller's turn.
    if (message.type === "result") {
      const turnId = runtimeTurnId(message);
      if (!turnId) return;
      const subtype = stringValue(message.subtype);
      if (message.is_error === true || subtype?.startsWith("error")) {
        await this.acceptTurnTerminal(turnId, {
          outcome: "failed",
          failure: message.codexError ?? message.error ?? message,
        });
      } else {
        await this.acceptTurnTerminal(turnId, { outcome: "completed" });
      }
      return;
    }

    // A provider can emit its authoritative turn terminal before the
    // matching user echo reaches the runtime stream. Unlike the generic
    // `complete` signal, this record carries the real Codex turn outcome and
    // is safe to settle an accepted dispatch. Replayed terminals are accepted
    // only after the matching user identity binds this controller to that same
    // turn, so an older turn cannot close a newly attached reply.
    if (message.type === "system" && message.subtype === "turn_complete") {
      const turnId = runtimeTurnId(message);
      if (!turnId) return;
      const turnStatus = stringValue(message.turnStatus);
      if (turnStatus === "failed") {
        await this.acceptTurnTerminal(turnId, {
          outcome: "failed",
          failure: message.codexError ?? message.error ?? message,
        });
      } else if (turnStatus === "interrupted") {
        await this.acceptTurnTerminal(turnId, { outcome: "interrupted" });
      } else {
        await this.acceptTurnTerminal(turnId, { outcome: "completed" });
      }
      return;
    }

    const retryStatus = codexRetryStatusValue(message.codexRetryStatus);
    if (
      message.type === "system" &&
      message.subtype === "warning" &&
      retryStatus
    ) {
      const safeStatus = retryStatusText(retryStatus);
      // Never let an upstream JSON-RPC message/data field enter the card even
      // if a malformed producer attaches it beside valid retry metadata.
      this.projection.observe({
        ...message,
        content: safeStatus,
        warning: safeStatus,
      });
      this.setState(retryStatus.state, safeStatus);
      return;
    }
    if (!this.turnStarted) return;
    const eventTurnId = runtimeTurnId(message);
    if (
      eventTurnId &&
      this.expectedTurnId &&
      eventTurnId !== this.expectedTurnId
    ) {
      return;
    }

    this.projection.observe(message);
    await this.projectGeneratedArtifact(message);

    if (
      message.type === "system" &&
      message.subtype === "warning" &&
      message.willRetry === true
    ) {
      this.setState("streaming", "Codex 暂时遇到问题，正在重试…");
      return;
    }

    const toolName = extractSafeToolName(message);
    if (toolName) {
      this.setState("streaming", `正在执行工具：${toolName}`);
    }

    const delta = extractTextDelta(message);
    if (delta) {
      this.markFirstToken();
      this.answer += delta;
      this.setState("streaming", "Codex 正在回复…");
      return;
    }
    const finalText = extractTextForFinalRender(message);
    if (finalText) {
      this.markFirstToken();
      if (message.codexMessagePhase === "commentary") {
        this.setState("streaming", "Codex 正在分析…");
      } else {
        this.answer = mergeAuthoritativeText(this.answer, finalText);
        this.setState("streaming", "Codex 正在回复…");
      }
      return;
    }
    this.scheduleUpdate();
  }

  private async observeTurnUser(
    message: Record<string, unknown>,
  ): Promise<boolean> {
    const tempMatches = stringValue(message.tempId) === this.options.tempId;
    const clientMessageId =
      stringValue(message.clientUserMessageId) ?? stringValue(message.uuid);
    if (tempMatches && clientMessageId) {
      this.clientUserMessageId = clientMessageId;
    }
    const clientMatches = Boolean(
      clientMessageId && clientMessageId === this.clientUserMessageId,
    );
    if (!tempMatches && !clientMatches) return false;

    const turnId = runtimeTurnId(message);
    if (!turnId) {
      // Process-generated optimistic echoes deliberately stop here for a
      // queue-after-turn admission. The provider echo will supply turnId once
      // turn/start really accepts the message.
      return true;
    }
    if (this.expectedTurnId && this.expectedTurnId !== turnId) return false;

    this.expectedTurnId = turnId;
    this.turnStarted = this.dispatchConfirmed;
    if (this.turnStarted) {
      this.setState("streaming", "Codex 正在处理…");
    }
    const pending = this.pendingTurnTerminals.get(turnId);
    this.pendingTurnTerminals.clear();
    if (pending && this.turnStarted) {
      await this.settleCorrelatedTerminal(pending);
    }
    return true;
  }

  private async acceptTurnTerminal(
    turnId: string,
    terminal: CorrelatedTurnTerminal,
  ): Promise<void> {
    if (!this.expectedTurnId) {
      const existing = this.pendingTurnTerminals.get(turnId);
      if (
        !existing ||
        terminalPriority(terminal.outcome) > terminalPriority(existing.outcome)
      ) {
        this.pendingTurnTerminals.set(turnId, terminal);
      }
      while (this.pendingTurnTerminals.size > 8) {
        const oldest = this.pendingTurnTerminals.keys().next().value;
        if (typeof oldest !== "string") break;
        this.pendingTurnTerminals.delete(oldest);
      }
      return;
    }
    if (turnId !== this.expectedTurnId || !this.turnStarted) return;
    await this.settleCorrelatedTerminal(terminal);
  }

  private async settleCorrelatedTerminal(
    terminal: CorrelatedTurnTerminal,
  ): Promise<void> {
    if (terminal.failure !== undefined) this.captureFailure(terminal.failure);
    await this.finalize(terminal.outcome);
  }

  private async projectGeneratedArtifact(
    message: Record<string, unknown>,
  ): Promise<void> {
    if (message.isReplay === true) return;
    const managed = managedArtifacts(message.codexGeneratedArtifacts);
    const managedWarnings = managedArtifactWarnings(
      message.codexGeneratedArtifactWarnings,
    );
    if (managed.length > 0 || managedWarnings.length > 0) {
      for (const warning of managedWarnings) {
        const effectId = `warning:${warning.sourceId}:${warning.reason}`;
        if (this.generatedArtifactWarningIds.has(effectId)) continue;
        this.generatedArtifactWarningIds.add(effectId);
        this.projection.recordGeneratedArtifactFailure(warning.reason);
      }
      for (const artifact of managed) {
        await this.projectManagedGeneratedArtifact(message, artifact);
      }
      this.scheduleUpdate();
      return;
    }

    const inspection = inspectCodexGeneratedImage(message);
    if (inspection.status === "not_applicable") return;
    const sourceId =
      inspection.status === "ready"
        ? inspection.artifact.sourceId
        : inspection.sourceId;
    const effectId = `legacy:${sourceId}`;
    if (this.generatedArtifactEffectIds.has(effectId)) return;

    if (inspection.status === "blocked") {
      if (this.generatedArtifactWarningIds.has(effectId)) return;
      this.generatedArtifactWarningIds.add(effectId);
      this.projection.recordGeneratedImageFailure(inspection.reason);
      this.scheduleUpdate();
      return;
    }
    const sendImageReply = this.options.api?.sendImageReply;
    if (!sendImageReply) {
      this.generatedArtifactRetryableIds.add(effectId);
      this.projection.recordGeneratedImageFailure("transport_unavailable");
      this.scheduleUpdate();
      return;
    }
    const deliveryIdentity = this.artifactDeliveryIdentity(message, {
      artifactId: `legacy:${inspection.artifact.sourceId}`,
      itemId: inspection.artifact.sourceId,
    });
    const image = {
      fileName: inspection.artifact.fileName,
      mimeType: inspection.artifact.mimeType,
      bytes: inspection.artifact.bytes,
      sizeBytes: inspection.artifact.sizeBytes,
      sha256: inspection.artifact.sha256,
      source: inspection.artifact.source,
      retention: inspection.artifact.retention,
      ...(deliveryIdentity ? { deliveryIdentity } : {}),
    };
    try {
      await sendImageReply.call(this.options.api, this.options.target, image);
      this.generatedArtifactEffectIds.add(effectId);
      this.generatedArtifactRetryableIds.delete(effectId);
      this.projection.recordGeneratedImage(image.fileName, image.sizeBytes);
    } catch (error) {
      this.generatedArtifactRetryableIds.add(effectId);
      this.projection.recordGeneratedImageFailure("upload_failed", error);
    }
    this.scheduleUpdate();
  }

  private async projectManagedGeneratedArtifact(
    message: Record<string, unknown>,
    artifact: GeneratedArtifactManifest,
  ): Promise<void> {
    const effectId = `managed:${artifact.id}`;
    if (
      this.generatedArtifactEffectIds.has(effectId) ||
      this.generatedArtifactInFlightIds.has(effectId)
    ) {
      return;
    }
    this.generatedArtifactInFlightIds.add(effectId);

    try {
      if (!isArtifactCorrelated(message, artifact)) {
        this.generatedArtifactRetryableIds.add(effectId);
        this.projection.recordGeneratedArtifactFailure("scope_mismatch");
        return;
      }
      const readArtifact = this.options.readGeneratedArtifact;
      if (!readArtifact) {
        this.generatedArtifactRetryableIds.add(effectId);
        this.projection.recordGeneratedArtifactFailure("transport_unavailable");
        return;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readArtifact(artifact);
      } catch (error) {
        this.generatedArtifactRetryableIds.add(effectId);
        this.projection.recordGeneratedArtifactFailure(
          "managed_read_failed",
          error,
        );
        return;
      }
      if (!validateGeneratedArtifactPayload(artifact, bytes)) {
        this.generatedArtifactRetryableIds.add(effectId);
        this.projection.recordGeneratedArtifactFailure("invalid_payload");
        return;
      }
      const outboundBytes = Uint8Array.from(bytes);
      if (!validateGeneratedArtifactPayload(artifact, outboundBytes)) {
        this.generatedArtifactRetryableIds.add(effectId);
        this.projection.recordGeneratedArtifactFailure("invalid_payload");
        return;
      }

      const deliveryIdentity = this.artifactDeliveryIdentity(message, {
        artifactId: artifact.id,
        itemId: artifact.source.itemId,
        threadId: artifact.source.threadId,
        turnId: artifact.source.turnId,
      });
      const upload = {
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
        bytes: outboundBytes,
        sizeBytes: outboundBytes.byteLength,
        sha256: artifact.sha256,
        source:
          artifact.source.type === "image_generation"
            ? ("codex_image_generation" as const)
            : ("codex_generated_file" as const),
        retention: "feishu_managed" as const,
        ...(deliveryIdentity ? { deliveryIdentity } : {}),
      };
      try {
        if (artifact.kind === "image") {
          const send = this.options.api?.sendImageReply;
          if (!send) {
            this.generatedArtifactRetryableIds.add(effectId);
            this.projection.recordGeneratedArtifactFailure(
              "transport_unavailable",
            );
            return;
          }
          await send.call(this.options.api, this.options.target, upload);
        } else if (artifact.kind === "video") {
          const send = this.options.api?.sendVideoReply;
          if (!send) {
            this.generatedArtifactRetryableIds.add(effectId);
            this.projection.recordGeneratedArtifactFailure(
              "transport_unavailable",
            );
            return;
          }
          await send.call(this.options.api, this.options.target, upload);
        } else {
          const send = this.options.api?.sendFileReply;
          if (!send) {
            this.generatedArtifactRetryableIds.add(effectId);
            this.projection.recordGeneratedArtifactFailure(
              "transport_unavailable",
            );
            return;
          }
          await send.call(this.options.api, this.options.target, upload);
        }
        this.generatedArtifactEffectIds.add(effectId);
        this.generatedArtifactRetryableIds.delete(effectId);
        this.projection.recordGeneratedArtifact(
          artifact.fileName,
          artifact.sizeBytes,
        );
      } catch (error) {
        this.generatedArtifactRetryableIds.add(effectId);
        this.projection.recordGeneratedArtifactFailure("upload_failed", error);
      }
    } finally {
      this.generatedArtifactInFlightIds.delete(effectId);
    }
  }

  private artifactDeliveryIdentity(
    message: Record<string, unknown>,
    input: {
      artifactId: string;
      itemId: string;
      threadId?: string;
      turnId?: string;
    },
  ): FeishuArtifactDeliveryIdentity | undefined {
    const scope = this.options.getArtifactDeliveryScope?.();
    const threadId = input.threadId ?? stringValue(message.codexThreadId);
    const turnId = input.turnId ?? stringValue(message.codexTurnId);
    if (!scope?.accountId || !scope.sessionId || !threadId || !turnId) {
      return undefined;
    }
    return {
      accountId: scope.accountId,
      sessionId: scope.sessionId,
      threadId,
      turnId,
      itemId: input.itemId,
      artifactId: input.artifactId,
    };
  }

  private setState(state: FeishuReplyState, statusText: string): void {
    if (this.terminal) return;
    this.stateValue = this.degraded ? "degraded_text" : state;
    this.statusText = statusText;
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (
      this.terminal ||
      this.degraded ||
      this.options.replyMode === "text" ||
      !this.options.api
    ) {
      return;
    }
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.enqueueOutput(() => this.flushCard());
    }, this.throttleMs);
    this.updateTimer.unref?.();
  }

  private enqueueOutput(operation: () => Promise<void>): Promise<void> {
    const output = this.outputChain.then(operation);
    this.outputChain = output.catch(() => undefined);
    return output;
  }

  private async flushCard(): Promise<void> {
    await this.start();
    const api = this.options.api;
    if (!api || this.degraded || !this.cardId) return;
    try {
      while (this.answer.length - this.cardOffset > this.maxCardChars) {
        const remaining = this.answer.slice(this.cardOffset);
        const splitIndex = findSafeSplitIndex(remaining, this.maxCardChars);
        const head = remaining.slice(0, splitIndex);
        await this.updateCardSnapshot(api, "本段已完成", head);
        await api.finishStreamingReply(
          this.cardId,
          ++this.sequence,
          summarize(head),
        );
        this.cardOffset += splitIndex;
        const initialContent = this.initialCardContent(
          this.statusText,
          this.answer.slice(this.cardOffset),
        );
        const next = await api.createStreamingReply(
          this.options.target,
          initialContent,
        );
        this.cardId = next.cardId;
        this.sequence = 0;
        this.lastRenderHash = undefined;
        this.lastRenderCardId = undefined;
        this.lastSectionRenderHashes.clear();
        this.rememberInitialCardRender(next.cardId, initialContent);
      }
      await this.updateCardSnapshot(
        api,
        this.statusText,
        this.answer.slice(this.cardOffset),
      );
    } catch {
      await this.degradeToText();
    }
  }

  private async finalize(
    terminalState: Extract<
      FeishuReplyState,
      "completed" | "interrupted" | "failed"
    >,
  ): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.statusText = terminalStatusText(terminalState);
    this.projection.settleRunning(
      terminalState === "completed" ? "completed" : "failed",
    );
    if (terminalState === "failed") {
      const hasPartialResult = Boolean(this.answer.trim());
      const failure =
        this.failure ??
        classifyCodexError(undefined, { correlationId: this.options.tempId });
      const publicCopy = feishuCodexErrorCopy(failure);
      const deepLink = this.options.getYepDeepLink?.();
      const detail = [
        publicCopy.publicMessage,
        `错误代码：${failure.code}（${failure.category}）`,
        `可重试：${failure.retryable ? "是" : "否"}`,
        `已有部分结果：${hasPartialResult ? "是" : "否"}`,
        publicCopy.nextAction,
        failure.correlationId ? `诊断 ID：${failure.correlationId}` : "",
        deepLink?.state === "available" ? `[在 Yep 查看](${deepLink.url})` : "",
      ]
        .filter(Boolean)
        .join("\n");
      this.answer = this.answer.trim()
        ? `${this.answer}\n\n---\n\n${detail}`
        : detail;
    } else if (!this.answer.trim()) {
      this.answer =
        terminalState === "interrupted"
          ? "任务已停止。"
          : "任务已完成，没有文本回复。";
    }
    await this.enqueueOutput(async () => {
      await this.start();
      if (
        this.options.api &&
        !this.degraded &&
        this.options.replyMode !== "text" &&
        this.cardId
      ) {
        await this.flushCard();
        if (!this.degraded && this.cardId) {
          await this.options.api
            .finishStreamingReply(
              this.cardId,
              ++this.sequence,
              summarize(this.answer),
            )
            .catch(() => undefined);
        } else if (this.degraded) {
          await this.sendTextResult();
        }
      } else {
        await this.sendTextResult();
      }
    });
    this.stateValue = this.degraded ? "degraded_text" : terminalState;
    this.options.onMetric?.("completed", Date.now() - this.startedAt);
    await this.options.onTerminal?.(this.stateValue, terminalState);
  }

  private async degradeToText(): Promise<void> {
    if (this.degraded) return;
    this.degraded = true;
    this.stateValue = "degraded_text";
    this.options.onMetric?.("card_degraded");
    if (this.options.api) {
      try {
        await this.options.api.sendTextReply(
          this.options.target,
          "卡片更新不可用，完成后将发送文本结果。",
        );
        this.markFirstFeedback();
      } catch {
        // Keep the controller alive so terminal fallback can retry.
      }
    }
  }

  private async sendTextResult(): Promise<void> {
    if (!this.options.api) return;
    const text = `${terminalStatusTextFromCurrent(this.statusText)}\n\n${this.answer}`;
    for (const chunk of splitText(text, this.maxTextChars)) {
      await this.options.api
        .sendTextReply(this.options.target, chunk)
        .catch(() => undefined);
    }
  }

  private markFirstFeedback(): void {
    if (this.firstFeedbackRecorded) return;
    this.firstFeedbackRecorded = true;
    this.options.onMetric?.("first_feedback", Date.now() - this.startedAt);
  }

  private markFirstToken(): void {
    if (this.firstTokenRecorded) return;
    this.firstTokenRecorded = true;
    this.options.onMetric?.("first_token", Date.now() - this.startedAt);
  }

  private captureFailure(error: unknown): void {
    const canonical = canonicalCodexErrorValue(error);
    if (!canonical) {
      this.failure = classifyCodexError(error, {
        correlationId: this.options.tempId,
      });
      return;
    }
    const correlationId = classifyCodexError(undefined, {
      correlationId: this.options.tempId,
    }).correlationId;
    this.failure = {
      ...canonical,
      ...(correlationId ? { correlationId } : {}),
    };
  }

  private renderCardContent(status: string, answer: string): string {
    return this.projection.render(status, answer, this.projectionMode());
  }

  private initialCardContent(status: string, answer: string): string {
    if (!this.supportsSectionedCard()) {
      return this.renderCardContent(status, answer);
    }
    return this.projection.renderSections(status, answer).status;
  }

  private async updateCardSnapshot(
    api: FeishuOutboundApi,
    status: string,
    answer: string,
  ): Promise<void> {
    const cardId = this.cardId;
    if (!cardId) return;
    if (this.supportsSectionedCard(api)) {
      const visibleElements = this.visibleCardElements(status, answer);
      const visibleIds = new Set(
        visibleElements.map((element) => element.elementId),
      );
      for (const elementId of [...this.createdSectionElementIds].reverse()) {
        if (
          elementId === FEISHU_STREAM_STATUS_ELEMENT_ID ||
          visibleIds.has(elementId)
        ) {
          continue;
        }
        await this.deleteCardSection(api, cardId, elementId);
      }
      let previousElementId: FeishuStreamingSectionElementId =
        FEISHU_STREAM_STATUS_ELEMENT_ID;
      for (const element of visibleElements) {
        if (this.createdSectionElementIds.has(element.elementId)) {
          await this.updateCardSection(
            api,
            cardId,
            element.elementId,
            element.content,
          );
        } else {
          await this.createCardSection(
            api,
            cardId,
            element.elementId,
            element.content,
            previousElementId,
          );
        }
        previousElementId = element.elementId;
      }
      return;
    }

    const content = this.renderCardContent(status, answer);
    if (this.isSameRender(cardId, content)) return;
    await api.updateStreamingReply(cardId, content, ++this.sequence);
    this.rememberRender(cardId, content);
    this.options.onMetric?.("card_updated");
  }

  private supportsSectionedCard(
    api: FeishuOutboundApi | undefined = this.options.api,
  ): boolean {
    return (
      this.options.replyMode === "card" &&
      typeof api?.updateStreamingReplySection === "function" &&
      typeof api.createStreamingReplySection === "function" &&
      typeof api.deleteStreamingReplySection === "function"
    );
  }

  private rememberInitialCardRender(cardId: string, content: string): void {
    if (!this.supportsSectionedCard()) {
      this.rememberRender(cardId, content);
      return;
    }
    this.createdSectionElementIds.clear();
    this.createdSectionElementIds.add(FEISHU_STREAM_STATUS_ELEMENT_ID);
    this.lastSectionRenderHashes.set(
      sectionRenderKey(cardId, FEISHU_STREAM_STATUS_ELEMENT_ID),
      renderHash(content),
    );
  }

  private visibleCardElements(
    status: string,
    answer: string,
  ): VisibleCardElement[] {
    const sections = this.projection.renderSections(status, answer);
    const progressRows = this.projection
      .renderStreamingProgressRows()
      .slice(0, FEISHU_STREAM_PROGRESS_ELEMENT_IDS.length);
    const activityRows = this.projection
      .renderStreamingActivityRows()
      .slice(0, FEISHU_STREAM_ACTIVITY_ELEMENT_IDS.length);
    return [
      {
        elementId: FEISHU_STREAM_STATUS_ELEMENT_ID,
        content: sections.status,
      },
      ...(progressRows.length > 0
        ? [
            {
              elementId: FEISHU_STREAM_PROGRESS_ELEMENT_ID,
              content: "### 进展",
            } satisfies VisibleCardElement,
            ...progressRows.flatMap((row, index) => {
              const elementId = FEISHU_STREAM_PROGRESS_ELEMENT_IDS[index];
              return elementId ? [{ elementId, content: row.content }] : [];
            }),
          ]
        : []),
      ...(activityRows.length > 0
        ? [
            {
              elementId: FEISHU_STREAM_TOOLS_ELEMENT_ID,
              content: "### 工具与活动",
            } satisfies VisibleCardElement,
            ...activityRows.flatMap((row, index) => {
              const elementId = FEISHU_STREAM_ACTIVITY_ELEMENT_IDS[index];
              return elementId ? [{ elementId, content: row.content }] : [];
            }),
          ]
        : []),
      ...(sections.artifacts.trim()
        ? [
            {
              elementId: FEISHU_STREAM_ARTIFACTS_ELEMENT_ID,
              content: sections.artifacts,
            } satisfies VisibleCardElement,
          ]
        : []),
      ...(sections.answer.trim()
        ? [
            {
              elementId: FEISHU_STREAM_ANSWER_ELEMENT_ID,
              content: sections.answer,
            } satisfies VisibleCardElement,
          ]
        : []),
    ];
  }

  private async createCardSection(
    api: FeishuOutboundApi,
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    content: string,
    previousElementId: FeishuStreamingSectionElementId,
  ): Promise<void> {
    await api.createStreamingReplySection?.call(
      api,
      cardId,
      elementId,
      content,
      { type: "insert_after", targetElementId: previousElementId },
      ++this.sequence,
    );
    this.createdSectionElementIds.add(elementId);
    this.lastSectionRenderHashes.set(
      sectionRenderKey(cardId, elementId),
      renderHash(content),
    );
    this.options.onMetric?.("card_updated");
  }

  private async deleteCardSection(
    api: FeishuOutboundApi,
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
  ): Promise<void> {
    await api.deleteStreamingReplySection?.call(
      api,
      cardId,
      elementId,
      ++this.sequence,
    );
    this.createdSectionElementIds.delete(elementId);
    this.lastSectionRenderHashes.delete(sectionRenderKey(cardId, elementId));
    this.options.onMetric?.("card_updated");
  }

  private async updateCardSection(
    api: FeishuOutboundApi,
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    content: string,
  ): Promise<void> {
    const key = sectionRenderKey(cardId, elementId);
    const hash = renderHash(content);
    if (this.lastSectionRenderHashes.get(key) === hash) return;
    await api.updateStreamingReplySection?.call(
      api,
      cardId,
      elementId,
      content,
      ++this.sequence,
    );
    this.lastSectionRenderHashes.set(key, hash);
    this.options.onMetric?.("card_updated");
  }

  private projectionMode(): FeishuCardProjectionMode {
    if (this.options.replyMode === "card") return "rich";
    if (this.options.replyMode === "markdown") return "compact";
    return "plain";
  }

  private isSameRender(cardId: string, content: string): boolean {
    return (
      this.lastRenderCardId === cardId &&
      this.lastRenderHash === renderHash(content)
    );
  }

  private rememberRender(cardId: string, content: string): void {
    this.lastRenderCardId = cardId;
    this.lastRenderHash = renderHash(content);
  }
}

function sectionRenderKey(
  cardId: string,
  elementId: FeishuStreamingSectionElementId,
): string {
  return `${cardId}\0${elementId}`;
}

function isPreDispatchTerminalEvent(eventType: string, data: unknown): boolean {
  if (eventType === "error" || eventType === "complete") return true;
  if (eventType !== "message") return false;
  const message = objectValue(data);
  return (
    message?.type === "error" ||
    message?.type === "result" ||
    (message?.type === "system" && message.subtype === "turn_complete")
  );
}

function isPreDispatchRetryEvent(eventType: string, data: unknown): boolean {
  if (eventType !== "message") return false;
  const message = objectValue(data);
  return Boolean(
    message?.type === "system" &&
      message.subtype === "warning" &&
      codexRetryStatusValue(message.codexRetryStatus),
  );
}

function codexRetryStatusValue(value: unknown): CodexRetryStatus | undefined {
  const status = objectValue(value);
  if (
    !status ||
    (status.state !== "queued" && status.state !== "retrying") ||
    status.category !== "overloaded" ||
    status.retryable !== true ||
    !isPositiveInteger(status.attempt) ||
    !isPositiveInteger(status.nextAttempt) ||
    !isPositiveInteger(status.maxAttempts) ||
    typeof status.retryInMs !== "number" ||
    !Number.isFinite(status.retryInMs) ||
    status.retryInMs < 0 ||
    status.nextAttempt !== status.attempt + 1 ||
    status.nextAttempt > status.maxAttempts
  ) {
    return undefined;
  }
  return status as unknown as CodexRetryStatus;
}

function retryStatusText(status: CodexRetryStatus): string {
  return status.state === "queued"
    ? `Codex 服务繁忙，任务已排队，准备自动重试（${status.nextAttempt}/${status.maxAttempts}）…`
    : `Codex 服务繁忙，正在自动重试（${status.nextAttempt}/${status.maxAttempts}）…`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalCodexErrorValue(
  value: unknown,
): CanonicalCodexError | undefined {
  const error = objectValue(value);
  if (!error || typeof error.code !== "string") return undefined;
  const copy = feishuCodexErrorCopyByCode(error.code);
  if (
    !copy ||
    error.category !== copy.category ||
    error.retryable !== copy.retryable
  ) {
    return undefined;
  }
  // Keep provider diagnostics alongside the stable localized category.
  return {
    code: error.code as CanonicalCodexError["code"],
    category: copy.category,
    retryable: copy.retryable,
    publicMessage:
      typeof error.publicMessage === "string"
        ? error.publicMessage
        : copy.publicMessage,
    nextAction:
      typeof error.nextAction === "string" ? error.nextAction : copy.nextAction,
  };
}

function feishuCodexErrorCopy(error: CanonicalCodexError): {
  publicMessage: string;
  nextAction: string;
} {
  const copy =
    feishuCodexErrorCopyByCode(error.code) ??
    FEISHU_CODEX_ERROR_COPY.CODEX_UNKNOWN;
  const fallback = classifyCodexError({ code: error.code });
  return {
    publicMessage:
      error.publicMessage && error.publicMessage !== fallback.publicMessage
        ? error.publicMessage
        : copy.publicMessage,
    nextAction:
      error.nextAction && error.nextAction !== fallback.nextAction
        ? error.nextAction
        : copy.nextAction,
  };
}

function feishuCodexErrorCopyByCode(
  code: string,
): (typeof FEISHU_CODEX_ERROR_COPY)[CanonicalCodexError["code"]] | undefined {
  return Object.prototype.hasOwnProperty.call(FEISHU_CODEX_ERROR_COPY, code)
    ? FEISHU_CODEX_ERROR_COPY[code as CanonicalCodexError["code"]]
    : undefined;
}

function terminalStatusText(
  state: "completed" | "interrupted" | "failed",
): string {
  if (state === "failed") return "任务失败";
  if (state === "interrupted") return "任务已停止";
  return "任务完成";
}

function terminalStatusTextFromCurrent(status: string): string {
  return status || "任务完成";
}

function mergeAuthoritativeText(current: string, finalText: string): string {
  if (!current) return finalText;
  if (finalText.startsWith(current)) return finalText;
  if (current.startsWith(finalText)) return current;
  return finalText;
}

function extractSafeToolName(message: Record<string, unknown>): string | null {
  const names: string[] = [];
  const topLevelName = stringValue(message.tool_name);
  if (topLevelName) names.push(topLevelName);
  for (const block of getMessageContent(message) ?? []) {
    const value = objectValue(block);
    if (value?.type === "tool_use") {
      const name = stringValue(value.name);
      if (name) names.push(name);
    }
  }
  const name = names[0]?.replace(/[^\p{L}\p{N}_.:/ -]/gu, "_").slice(0, 80);
  return name || null;
}

function findSafeSplitIndex(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const paragraph = text.lastIndexOf("\n\n", limit);
  if (paragraph >= Math.floor(limit * 0.5)) return paragraph + 2;
  const line = text.lastIndexOf("\n", limit);
  if (line >= Math.floor(limit * 0.5)) return line + 1;
  return limit;
}

function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const index = findSafeSplitIndex(remaining, limit);
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index);
  }
  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

function summarize(text: string): string {
  const value = text.replace(/\s+/g, " ").trim() || "任务完成";
  return value.length <= 50 ? value : `${value.slice(0, 49)}…`;
}

function renderHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MANAGED_ARTIFACT_REASONS = new Set<GeneratedArtifactBlockReason>([
  "invalid_payload",
  "scope_mismatch",
  "outside_workspace",
  "not_regular_file",
  "hard_link",
  "cross_device",
  "symlink",
  "changed_during_read",
  "size_limit",
  "count_limit",
  "sensitive_content",
  "high_risk_archive",
  "mime_mismatch",
  "unsupported_format",
  "storage_failed",
]);

function managedArtifacts(value: unknown): GeneratedArtifactManifest[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((candidate) => {
    const artifact = objectValue(candidate);
    const source = objectValue(artifact?.source);
    const retention = objectValue(artifact?.retention);
    const kind = artifact?.kind;
    const sizeBytes = artifact?.sizeBytes;
    const sha256 = artifact?.sha256;
    const expiresAtMs =
      typeof retention?.expiresAt === "string"
        ? Date.parse(retention.expiresAt)
        : Number.NaN;
    if (
      artifact?.schemaVersion !== 1 ||
      typeof artifact.id !== "string" ||
      !/^ga_[a-f0-9]{32}$/.test(artifact.id) ||
      typeof artifact.managedRef !== "string" ||
      !/^upload:[a-f0-9-]{36}$/.test(artifact.managedRef) ||
      typeof artifact.fileName !== "string" ||
      artifact.fileName.length === 0 ||
      artifact.fileName.length > 120 ||
      hasUnsafeArtifactFileName(artifact.fileName) ||
      ![
        "image",
        "document",
        "spreadsheet",
        "presentation",
        "text",
        "video",
      ].includes(typeof kind === "string" ? kind : "") ||
      typeof artifact.mimeType !== "string" ||
      artifact.mimeType.length === 0 ||
      artifact.mimeType.length > 160 ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > 30 * 1024 * 1024 ||
      typeof sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(sha256) ||
      source?.provider !== "codex" ||
      (source.type !== "image_generation" && source.type !== "file_change") ||
      typeof source.threadId !== "string" ||
      typeof source.turnId !== "string" ||
      typeof source.itemId !== "string" ||
      retention?.policy !== "temporary" ||
      typeof retention.expiresAt !== "string" ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= Date.now() ||
      typeof artifact.downloadUrl !== "string" ||
      !isGeneratedArtifactDownloadUrl(artifact.downloadUrl) ||
      !artifact.downloadUrl.endsWith(
        `/generated-artifact/${artifact.id}/${sha256.slice(
          "sha256:".length,
        )}/${encodeURIComponent(artifact.fileName)}`,
      ) ||
      (artifact.previewUrl !== undefined &&
        (kind !== "image" ||
          typeof artifact.previewUrl !== "string" ||
          artifact.previewUrl !== artifact.downloadUrl))
    ) {
      return [];
    }
    return [
      {
        schemaVersion: 1,
        id: artifact.id,
        managedRef: artifact.managedRef,
        fileName: artifact.fileName,
        kind: kind as GeneratedArtifactManifest["kind"],
        mimeType: artifact.mimeType,
        sizeBytes,
        sha256,
        source: {
          provider: "codex",
          type: source.type,
          threadId: source.threadId,
          turnId: source.turnId,
          itemId: source.itemId,
        },
        retention: {
          policy: "temporary",
          expiresAt: retention.expiresAt,
        },
        downloadUrl: artifact.downloadUrl,
        ...(typeof artifact.previewUrl === "string"
          ? { previewUrl: artifact.previewUrl }
          : {}),
      } satisfies GeneratedArtifactManifest,
    ];
  });
}

function managedArtifactWarnings(value: unknown): GeneratedArtifactWarning[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate) => {
    const warning = objectValue(candidate);
    return typeof warning?.sourceId === "string" &&
      warning.sourceId.length > 0 &&
      warning.sourceId.length <= 256 &&
      typeof warning.reason === "string" &&
      MANAGED_ARTIFACT_REASONS.has(
        warning.reason as GeneratedArtifactBlockReason,
      )
      ? [
          {
            sourceId: warning.sourceId,
            reason: warning.reason as GeneratedArtifactBlockReason,
          },
        ]
      : [];
  });
}

function hasUnsafeArtifactFileName(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      character === "\\" ||
      character === "/"
    ) {
      return true;
    }
  }
  return false;
}

function isArtifactCorrelated(
  message: Record<string, unknown>,
  artifact: GeneratedArtifactManifest,
): boolean {
  if (
    message.codexThreadItemLifecycle !== "completed" ||
    stringValue(message.codexThreadId) !== artifact.source.threadId ||
    stringValue(message.codexTurnId) !== artifact.source.turnId
  ) {
    return false;
  }
  const item = objectValue(message.codexThreadItem);
  const itemId = stringValue(item?.id) ?? messageProviderItemId(message);
  if (itemId !== artifact.source.itemId) return false;
  if (!item) return true;
  return artifact.source.type === "image_generation"
    ? item.type === "imageGeneration"
    : item.type === "fileChange";
}

function messageProviderItemId(
  message: Record<string, unknown>,
): string | undefined {
  for (const rawBlock of getMessageContent(message) ?? []) {
    const block = objectValue(rawBlock);
    if (!block) continue;
    const id =
      block.type === "tool_use"
        ? stringValue(block.id)
        : block.type === "tool_result"
          ? stringValue(block.tool_use_id)
          : undefined;
    if (id) return id;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function containsToolResult(message: Record<string, unknown>): boolean {
  return (getMessageContent(message) ?? []).some(
    (block) => objectValue(block)?.type === "tool_result",
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function runtimeTurnId(message: Record<string, unknown>): string | undefined {
  return stringValue(message.turnId) ?? stringValue(message.codexTurnId);
}

function terminalPriority(outcome: CorrelatedTurnTerminal["outcome"]): number {
  if (outcome === "failed") return 3;
  if (outcome === "interrupted") return 2;
  return 1;
}
