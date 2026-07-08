import { type UrlProjectId, isSlashCommandSession } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import {
  extractFirstAssistantResponseText,
  extractFirstUserPromptText,
} from "../sessions/session-message-text.js";
import type { Session } from "../supervisor/types.js";
import type { BusEvent, EventBus } from "../watcher/EventBus.js";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_API_BASE = "https://api.ohmyrouter.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_SCHEDULE_DELAY_MS = 1500;
const DEFAULT_MIN_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const MIN_MESSAGE_COUNT_FOR_TITLE = 2;
const MAX_LOG_SNIPPET_CHARS = 500;
const TITLE_MODEL_MAX_TOKENS = 100000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SessionOwner = Session["ownership"]["owner"];
type TitleGenerationTrigger =
  | "manual"
  | "completed-unowned-session"
  | "external-session-updated"
  | "unowned-session-updated"
  | "process-idle";

export interface SessionTitleServiceOptions {
  eventBus: EventBus;
  metadataService: SessionMetadataService;
  loadSession: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<Session | null>;
  enabled?: boolean;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  subModule?: string;
  requestTimeoutMs?: number;
  scheduleDelayMs?: number;
  minRetryIntervalMs?: number;
  fetchImpl?: FetchLike;
}

export class SessionTitleService {
  private readonly eventBus: EventBus;
  private readonly metadataService: SessionMetadataService;
  private readonly loadSession: SessionTitleServiceOptions["loadSession"];
  private readonly enabled: boolean;
  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly subModule: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly scheduleDelayMs: number;
  private readonly minRetryIntervalMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly sessionOwners = new Map<string, SessionOwner>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: SessionTitleServiceOptions) {
    this.eventBus = options.eventBus;
    this.metadataService = options.metadataService;
    this.loadSession = options.loadSession;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.subModule = options.subModule?.trim() || undefined;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.scheduleDelayMs = options.scheduleDelayMs ?? DEFAULT_SCHEDULE_DELAY_MS;
    this.minRetryIntervalMs =
      options.minRetryIntervalMs ?? DEFAULT_MIN_RETRY_INTERVAL_MS;
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.enabled = (options.enabled ?? true) && Boolean(this.apiKey);
  }

  start(): void {
    if (!this.enabled || this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.scheduled.values()) {
      clearTimeout(timer);
    }
    this.scheduled.clear();
  }

  async generateForSession(
    sessionId: string,
    projectId: UrlProjectId,
    trigger: TitleGenerationTrigger = "manual",
  ): Promise<void> {
    const log = getLogger();
    if (!this.enabled) {
      log.debug(
        { sessionId, projectId, trigger },
        "[SessionTitleService] Skipping title generation: service disabled",
      );
      return;
    }
    if (this.inFlight.has(sessionId)) {
      log.info(
        { sessionId, projectId, trigger },
        "[SessionTitleService] Skipping title generation: already in flight",
      );
      return;
    }

    const lastAttempt = this.lastAttemptAt.get(sessionId);
    if (
      lastAttempt !== undefined &&
      Date.now() - lastAttempt < this.minRetryIntervalMs
    ) {
      log.info(
        {
          sessionId,
          projectId,
          trigger,
          elapsedMs: Date.now() - lastAttempt,
          minRetryIntervalMs: this.minRetryIntervalMs,
        },
        "[SessionTitleService] Skipping title generation: retry interval not elapsed",
      );
      return;
    }

    const initialMetadata = this.metadataService.getMetadata(sessionId);
    if (initialMetadata?.customTitle || initialMetadata?.aiTitle) {
      log.info(
        {
          sessionId,
          projectId,
          trigger,
          hasCustomTitle: Boolean(initialMetadata.customTitle),
          hasAiTitle: Boolean(initialMetadata.aiTitle),
        },
        "[SessionTitleService] Skipping title generation: title already exists",
      );
      return;
    }

    this.inFlight.add(sessionId);
    try {
      log.info(
        { sessionId, projectId, trigger },
        "[SessionTitleService] Starting title generation attempt",
      );
      const session = await this.loadSession(sessionId, projectId);
      if (!session || session.messageCount < MIN_MESSAGE_COUNT_FOR_TITLE) {
        log.info(
          {
            sessionId,
            projectId,
            trigger,
            foundSession: Boolean(session),
            messageCount: session?.messageCount ?? 0,
            minMessageCount: MIN_MESSAGE_COUNT_FOR_TITLE,
          },
          "[SessionTitleService] Skipping title generation: session is not ready",
        );
        return;
      }

      const latestMetadata = this.metadataService.getMetadata(sessionId);
      if (latestMetadata?.customTitle || latestMetadata?.aiTitle) {
        log.info(
          {
            sessionId,
            projectId,
            trigger,
            hasCustomTitle: Boolean(latestMetadata.customTitle),
            hasAiTitle: Boolean(latestMetadata.aiTitle),
          },
          "[SessionTitleService] Skipping title generation: title was added before attempt",
        );
        return;
      }
      if (
        isSlashCommandSession({
          title: session.fullTitle ?? session.title,
          customTitle: latestMetadata?.customTitle ?? session.customTitle,
        })
      ) {
        log.info(
          {
            sessionId,
            projectId,
            trigger,
            title: session.fullTitle ?? session.title,
          },
          "[SessionTitleService] Skipping title generation: slash command session",
        );
        return;
      }

      const firstUserMessage = extractFirstUserPromptText(session);
      const firstAssistantMessage = extractFirstAssistantResponseText(session);
      log.info(
        {
          sessionId,
          projectId,
          trigger,
          provider: session.provider,
          messageCount: session.messageCount,
          ownershipOwner: session.ownership?.owner,
          hasFirstUserMessage: Boolean(firstUserMessage?.trim()),
          firstUserMessageChars: firstUserMessage?.trim().length ?? 0,
          hasFirstAssistantMessage: Boolean(firstAssistantMessage?.trim()),
          firstAssistantMessageChars: firstAssistantMessage?.trim().length ?? 0,
        },
        "[SessionTitleService] Loaded title generation context",
      );
      if (!firstUserMessage?.trim() || !firstAssistantMessage?.trim()) {
        log.info(
          {
            sessionId,
            projectId,
            trigger,
            hasFirstUserMessage: Boolean(firstUserMessage?.trim()),
            hasFirstAssistantMessage: Boolean(firstAssistantMessage?.trim()),
          },
          "[SessionTitleService] Skipping title generation: missing first user prompt or final assistant response",
        );
        return;
      }

      this.lastAttemptAt.set(sessionId, Date.now());
      const title = await this.generateTitle(
        {
          userMessage: firstUserMessage,
          assistantMessage: firstAssistantMessage,
        },
        { sessionId, projectId, trigger },
      );
      if (!title) {
        log.info(
          { sessionId, projectId, trigger, model: this.model },
          "[SessionTitleService] Skipping title save: title model produced no usable title",
        );
        return;
      }

      const metadataBeforeSave = this.metadataService.getMetadata(sessionId);
      if (metadataBeforeSave?.customTitle || metadataBeforeSave?.aiTitle) {
        log.info(
          {
            sessionId,
            projectId,
            trigger,
            hasCustomTitle: Boolean(metadataBeforeSave.customTitle),
            hasAiTitle: Boolean(metadataBeforeSave.aiTitle),
          },
          "[SessionTitleService] Skipping title save: title was added after model call",
        );
        return;
      }

      await this.metadataService.setAiTitle(sessionId, title);
      log.info(
        {
          sessionId,
          projectId,
          trigger,
          title,
          titleChars: title.length,
        },
        "[SessionTitleService] Saved AI session title",
      );
      this.eventBus.emit({
        type: "session-metadata-changed",
        sessionId,
        projectId,
        aiTitle: title,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      getLogger().warn(
        { err: error, sessionId, projectId, trigger, model: this.model },
        "[SessionTitleService] Failed to generate session title",
      );
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private handleEvent(event: BusEvent): void {
    if (event.type === "session-created") {
      const owner = event.session.ownership.owner;
      this.sessionOwners.set(event.session.id, owner);
      if (
        owner === "none" &&
        event.session.messageCount >= MIN_MESSAGE_COUNT_FOR_TITLE
      ) {
        this.schedule(
          event.session.id,
          event.session.projectId,
          "completed-unowned-session",
        );
      }
      return;
    }

    if (event.type === "session-status-changed") {
      const previousOwner = this.sessionOwners.get(event.sessionId);
      const owner = event.ownership.owner;
      this.sessionOwners.set(event.sessionId, owner);
      if (owner === "none" && previousOwner !== "self") {
        this.schedule(
          event.sessionId,
          event.projectId,
          "completed-unowned-session",
        );
      }
      return;
    }

    if (event.type === "session-updated") {
      const owner = this.sessionOwners.get(event.sessionId);
      if (
        owner !== "self" &&
        (event.messageCount === undefined ||
          event.messageCount >= MIN_MESSAGE_COUNT_FOR_TITLE)
      ) {
        this.schedule(
          event.sessionId,
          event.projectId,
          owner === "external"
            ? "external-session-updated"
            : "unowned-session-updated",
        );
      }
      return;
    }

    if (event.type === "process-state-changed" && event.activity === "idle") {
      this.schedule(event.sessionId, event.projectId, "process-idle");
    }
  }

  private schedule(
    sessionId: string,
    projectId: UrlProjectId,
    trigger: TitleGenerationTrigger,
  ): void {
    const log = getLogger();
    if (!this.enabled) {
      log.debug(
        { sessionId, projectId, trigger },
        "[SessionTitleService] Not scheduling title generation: service disabled",
      );
      return;
    }
    if (this.scheduled.has(sessionId)) {
      log.info(
        { sessionId, projectId, trigger },
        "[SessionTitleService] Not scheduling title generation: already scheduled",
      );
      return;
    }
    log.info(
      { sessionId, projectId, trigger, delayMs: this.scheduleDelayMs },
      "[SessionTitleService] Scheduled title generation",
    );
    const timer = setTimeout(() => {
      this.scheduled.delete(sessionId);
      void this.generateForSession(sessionId, projectId, trigger);
    }, this.scheduleDelayMs);
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    this.scheduled.set(sessionId, timer);
  }

  private async generateTitle(
    input: {
      userMessage: string;
      assistantMessage: string;
    },
    context: {
      sessionId: string;
      projectId: UrlProjectId;
      trigger: TitleGenerationTrigger;
    },
  ): Promise<string | null> {
    if (!this.apiKey) return null;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.subModule) {
      headers["X-Sub-Module"] = this.subModule;
    }

    const requiredLanguage = getPreferredTitleLanguage(input.userMessage);
    const url = getChatCompletionsUrl(this.apiBase);
    getLogger().info(
      {
        ...context,
        model: this.model,
        apiBase: redactUrlForLog(url),
        requiredLanguage,
        userMessageChars: input.userMessage.length,
        assistantMessageChars: input.assistantMessage.length,
      },
      "[SessionTitleService] Calling title model",
    );
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: TITLE_MODEL_MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: [
              "You generate precise chat session titles.",
              'Output only valid JSON: {"title":"..."}.',
              "Return exactly one concise title in the title field; do not include reasoning, explanations, alternate titles, or extra JSON fields.",
              "Use the dominant language of the first user message.",
              "If the first user message contains meaningful Chinese, the title must be Chinese, not an English translation.",
              "For Chinese titles, prefer 12-24 Chinese characters.",
              "For English titles, prefer 4-8 words.",
              "Preserve key technical terms such as file names, APIs, product names, and command names.",
              "Do not add punctuation, quotes outside JSON, markdown, or explanations.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              "Required title language:",
              requiredLanguage,
              "",
              "First user message:",
              normalizeForPrompt(input.userMessage),
              "",
              "First assistant response:",
              normalizeForPrompt(input.assistantMessage),
            ].join("\n"),
          },
        ],
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await response
        .text()
        .then((value) => truncateForLog(value))
        .catch(() => "");
      throw new Error(
        [
          `title model request failed: ${response.status} ${response.statusText}`,
          body ? `body=${body}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    const payload = (await response.json()) as {
      id?: unknown;
      usage?: unknown;
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown; reasoning_content?: unknown };
      }>;
    };
    const choice = payload.choices?.[0];
    const message = choice?.message;
    const content = message?.content;
    if (typeof content !== "string") {
      getLogger().warn(
        {
          ...context,
          model: this.model,
          contentType: typeof content,
          finishReason: choice?.finish_reason,
          responseId: typeof payload.id === "string" ? payload.id : undefined,
          usage: payload.usage,
          messageKeys: message ? Object.keys(message) : [],
        },
        "[SessionTitleService] Title model response missing string content",
      );
      return null;
    }
    const title = sanitizeTitle(content);
    if (!title) {
      getLogger().warn(
        {
          ...context,
          model: this.model,
          rawContentChars: content.length,
          rawContentSnippet: truncateForLog(content),
          finishReason: choice?.finish_reason,
          responseId: typeof payload.id === "string" ? payload.id : undefined,
          usage: payload.usage,
          messageKeys: message ? Object.keys(message) : [],
          reasoningContentChars:
            typeof message?.reasoning_content === "string"
              ? message.reasoning_content.length
              : undefined,
        },
        "[SessionTitleService] Title model response sanitized to empty title",
      );
      return null;
    }
    if (!isTitleLanguageAllowed(title, requiredLanguage)) {
      getLogger().warn(
        {
          ...context,
          model: this.model,
          requiredLanguage,
          title,
          titleChars: title.length,
          finishReason: choice?.finish_reason,
          responseId: typeof payload.id === "string" ? payload.id : undefined,
          usage: payload.usage,
        },
        "[SessionTitleService] Title model response rejected by language guard",
      );
      return null;
    }
    getLogger().info(
      {
        ...context,
        model: this.model,
        requiredLanguage,
        title,
        titleChars: title.length,
        finishReason: choice?.finish_reason,
        responseId: typeof payload.id === "string" ? payload.id : undefined,
        usage: payload.usage,
      },
      "[SessionTitleService] Accepted title model output",
    );
    return title;
  }
}

function getChatCompletionsUrl(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

function normalizeForPrompt(value: string): string {
  return value.trim();
}

function truncateForLog(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_LOG_SNIPPET_CHARS
    ? compact
    : compact.slice(0, MAX_LOG_SNIPPET_CHARS);
}

function redactUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function sanitizeTitle(raw: string): string | null {
  let candidate = raw.trim();
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonCandidate = jsonMatch?.[0];
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as { title?: unknown };
      if (typeof parsed.title === "string") {
        candidate = parsed.title;
      }
    } catch {
      // Fall back to cleaning the raw model output.
    }
  }

  candidate = candidate
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .replace(/^\s*(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[。.!?？；;，,]+$/g, "")
    .trim();

  if (!candidate) return null;
  return candidate;
}

function getPreferredTitleLanguage(userMessage: string): "Chinese" | "English" {
  return containsCjk(userMessage) ? "Chinese" : "English";
}

function isTitleLanguageAllowed(
  title: string,
  requiredLanguage: "Chinese" | "English",
): boolean {
  return requiredLanguage !== "Chinese" || containsCjk(title);
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}
