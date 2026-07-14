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
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_STARTUP_BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STARTUP_BACKFILL_LIMIT = 25;
const DEFAULT_STARTUP_BACKFILL_CONCURRENCY = 2;
const DEFAULT_STARTUP_BACKFILL_MAX_PROJECTS = 20;
const MIN_MESSAGE_COUNT_FOR_TITLE = 2;
const MAX_LOG_SNIPPET_CHARS = 500;
const TITLE_MODEL_MAX_TOKENS = 100000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SessionOwner = Session["ownership"]["owner"];
interface TitleModelFailure {
  retryable: boolean;
  kind: string;
  statusCode?: number;
  retryAfterMs?: number;
}

class TitleModelRequestError extends Error implements TitleModelFailure {
  readonly retryable: boolean;
  readonly kind: string;
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, failure: TitleModelFailure) {
    super(message);
    this.name = "TitleModelRequestError";
    this.retryable = failure.retryable;
    this.kind = failure.kind;
    this.statusCode = failure.statusCode;
    this.retryAfterMs = failure.retryAfterMs;
  }
}

type TitleGenerationTrigger =
  | "manual"
  | "completed-unowned-session"
  | "external-session-updated"
  | "unowned-session-updated"
  | "process-idle"
  | "startup-backfill";

export interface SessionTitleBackfillCandidate {
  sessionId: string;
  projectId: UrlProjectId;
  updatedAt: string;
  messageCount: number;
}

export interface SessionTitleBackfillScanResult {
  candidates: SessionTitleBackfillCandidate[];
  scannedProjects: number;
  scannedSessions: number;
}

export interface SessionTitleBackfillScanOptions {
  updatedAfterMs: number;
  limit: number;
  maxProjects: number;
}

export interface SessionTitleServiceOptions {
  eventBus: EventBus;
  metadataService: SessionMetadataService;
  loadSession: (
    sessionId: string,
    projectId: UrlProjectId,
  ) => Promise<Session | null>;
  scanRecentSessions?: (
    options: SessionTitleBackfillScanOptions,
  ) => Promise<SessionTitleBackfillScanResult>;
  enabled?: boolean;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  subModule?: string;
  requestTimeoutMs?: number;
  scheduleDelayMs?: number;
  minRetryIntervalMs?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  startupBackfillWindowMs?: number;
  startupBackfillLimit?: number;
  startupBackfillConcurrency?: number;
  startupBackfillMaxProjects?: number;
  fetchImpl?: FetchLike;
}

export class SessionTitleService {
  private readonly eventBus: EventBus;
  private readonly metadataService: SessionMetadataService;
  private readonly loadSession: SessionTitleServiceOptions["loadSession"];
  private readonly scanRecentSessions:
    | SessionTitleServiceOptions["scanRecentSessions"]
    | undefined;
  private readonly enabled: boolean;
  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly subModule: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly scheduleDelayMs: number;
  private readonly minRetryIntervalMs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly startupBackfillWindowMs: number;
  private readonly startupBackfillLimit: number;
  private readonly startupBackfillConcurrency: number;
  private readonly startupBackfillMaxProjects: number;
  private readonly fetchImpl: FetchLike;
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryWaits = new Map<
    ReturnType<typeof setTimeout>,
    () => void
  >();
  private readonly inFlight = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly sessionOwners = new Map<string, SessionOwner>();
  private unsubscribe: (() => void) | null = null;
  private startupBackfillPromise: Promise<void> | null = null;
  private lifecycleId = 0;
  private stopped = false;

  constructor(options: SessionTitleServiceOptions) {
    this.eventBus = options.eventBus;
    this.metadataService = options.metadataService;
    this.loadSession = options.loadSession;
    this.scanRecentSessions = options.scanRecentSessions;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.subModule = options.subModule?.trim() || undefined;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.scheduleDelayMs = options.scheduleDelayMs ?? DEFAULT_SCHEDULE_DELAY_MS;
    this.minRetryIntervalMs =
      options.minRetryIntervalMs ?? DEFAULT_MIN_RETRY_INTERVAL_MS;
    this.retryMaxAttempts = Math.max(
      1,
      Math.floor(options.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS),
    );
    this.retryBaseDelayMs = Math.max(
      0,
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    );
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    );
    this.startupBackfillWindowMs = Math.max(
      0,
      options.startupBackfillWindowMs ?? DEFAULT_STARTUP_BACKFILL_WINDOW_MS,
    );
    this.startupBackfillLimit = Math.max(
      0,
      Math.floor(
        options.startupBackfillLimit ?? DEFAULT_STARTUP_BACKFILL_LIMIT,
      ),
    );
    this.startupBackfillConcurrency = Math.max(
      1,
      Math.floor(
        options.startupBackfillConcurrency ??
          DEFAULT_STARTUP_BACKFILL_CONCURRENCY,
      ),
    );
    this.startupBackfillMaxProjects = Math.max(
      1,
      Math.floor(
        options.startupBackfillMaxProjects ??
          DEFAULT_STARTUP_BACKFILL_MAX_PROJECTS,
      ),
    );
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.enabled = (options.enabled ?? true) && Boolean(this.apiKey);
  }

  start(): void {
    if (!this.enabled || this.unsubscribe) return;
    this.stopped = false;
    const lifecycleId = ++this.lifecycleId;
    this.unsubscribe = this.eventBus.subscribe((event) => {
      this.handleEvent(event);
    });
    if (this.scanRecentSessions && this.startupBackfillLimit > 0) {
      const backfill = this.runStartupBackfill(lifecycleId);
      this.startupBackfillPromise = backfill;
      const clearBackfill = () => {
        if (this.startupBackfillPromise === backfill) {
          this.startupBackfillPromise = null;
        }
      };
      void backfill.then(clearBackfill, clearBackfill);
    }
  }

  async waitForStartupBackfill(): Promise<void> {
    await this.startupBackfillPromise;
  }

  stop(): void {
    this.stopped = true;
    this.lifecycleId += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.scheduled.values()) {
      clearTimeout(timer);
    }
    this.scheduled.clear();
    for (const cancel of Array.from(this.retryWaits.values())) {
      cancel();
    }
    this.retryWaits.clear();
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

      let title: string | null = null;
      for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt += 1) {
        const metadataBeforeAttempt =
          this.metadataService.getMetadata(sessionId);
        if (
          metadataBeforeAttempt?.customTitle ||
          metadataBeforeAttempt?.aiTitle
        ) {
          log.info(
            {
              sessionId,
              projectId,
              trigger,
              attempt,
              hasCustomTitle: Boolean(metadataBeforeAttempt.customTitle),
              hasAiTitle: Boolean(metadataBeforeAttempt.aiTitle),
            },
            "[SessionTitleService] Skipping title generation retry: title was added",
          );
          return;
        }

        this.lastAttemptAt.set(sessionId, Date.now());
        try {
          title = await this.generateTitle(
            {
              userMessage: firstUserMessage,
              assistantMessage: firstAssistantMessage,
            },
            {
              sessionId,
              projectId,
              trigger,
              attempt,
              maxAttempts: this.retryMaxAttempts,
            },
          );
          break;
        } catch (error) {
          const failure = toTitleModelFailure(error);
          const canRetry = failure.retryable && attempt < this.retryMaxAttempts;
          if (!canRetry) {
            log.warn(
              {
                err: error,
                sessionId,
                projectId,
                trigger,
                model: this.model,
                attempt,
                maxAttempts: this.retryMaxAttempts,
                retryable: failure.retryable,
                failureKind: failure.kind,
                statusCode: failure.statusCode,
              },
              "[SessionTitleService] Title generation failed permanently",
            );
            return;
          }

          const retryDelayMs = this.getRetryDelayMs(failure, attempt);
          log.warn(
            {
              err: error,
              sessionId,
              projectId,
              trigger,
              model: this.model,
              attempt,
              nextAttempt: attempt + 1,
              maxAttempts: this.retryMaxAttempts,
              retryDelayMs,
              failureKind: failure.kind,
              statusCode: failure.statusCode,
              retryAfterMs: failure.retryAfterMs,
            },
            "[SessionTitleService] Title generation attempt failed; scheduling retry",
          );
          if (!(await this.waitForRetry(retryDelayMs))) {
            log.info(
              { sessionId, projectId, trigger, attempt },
              "[SessionTitleService] Cancelled title generation retry: service stopped",
            );
            return;
          }
        }
      }

      if (!title) return;

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
        "[SessionTitleService] Failed outside title model request",
      );
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async runStartupBackfill(lifecycleId: number): Promise<void> {
    if (!this.scanRecentSessions) return;

    const log = getLogger();
    const startedAt = Date.now();
    const updatedAfterMs = startedAt - this.startupBackfillWindowMs;
    log.info(
      {
        updatedAfter: new Date(updatedAfterMs).toISOString(),
        windowMs: this.startupBackfillWindowMs,
        limit: this.startupBackfillLimit,
        concurrency: this.startupBackfillConcurrency,
        maxProjects: this.startupBackfillMaxProjects,
      },
      "[SessionTitleService] Starting recent session title backfill",
    );

    let scan: SessionTitleBackfillScanResult;
    try {
      scan = await this.scanRecentSessions({
        updatedAfterMs,
        limit: this.startupBackfillLimit,
        maxProjects: this.startupBackfillMaxProjects,
      });
    } catch (error) {
      log.warn(
        { err: error, limit: this.startupBackfillLimit },
        "[SessionTitleService] Startup title backfill scan failed",
      );
      return;
    }

    if (this.stopped || lifecycleId !== this.lifecycleId) {
      log.info(
        {
          scannedProjects: scan.scannedProjects,
          scannedSessions: scan.scannedSessions,
        },
        "[SessionTitleService] Discarding startup title backfill scan: service stopped",
      );
      return;
    }

    const seen = new Set<string>();
    const candidates: SessionTitleBackfillCandidate[] = [];
    let skippedOutsideWindow = 0;
    let skippedNotReady = 0;
    let skippedAlreadyTitled = 0;
    let skippedDuplicate = 0;

    for (const candidate of scan.candidates) {
      if (candidates.length >= this.startupBackfillLimit) break;
      const updatedAtMs = new Date(candidate.updatedAt).getTime();
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < updatedAfterMs) {
        skippedOutsideWindow += 1;
        continue;
      }
      if (candidate.messageCount < MIN_MESSAGE_COUNT_FOR_TITLE) {
        skippedNotReady += 1;
        continue;
      }
      if (seen.has(candidate.sessionId)) {
        skippedDuplicate += 1;
        continue;
      }
      seen.add(candidate.sessionId);

      const metadata = this.metadataService.getMetadata(candidate.sessionId);
      if (metadata?.customTitle || metadata?.aiTitle) {
        skippedAlreadyTitled += 1;
        log.info(
          {
            sessionId: candidate.sessionId,
            projectId: candidate.projectId,
            trigger: "startup-backfill",
            hasCustomTitle: Boolean(metadata.customTitle),
            hasAiTitle: Boolean(metadata.aiTitle),
          },
          "[SessionTitleService] Skipping startup backfill candidate: title already exists",
        );
        continue;
      }
      candidates.push(candidate);
    }

    log.info(
      {
        scannedProjects: scan.scannedProjects,
        scannedSessions: scan.scannedSessions,
        returnedCandidates: scan.candidates.length,
        selectedCandidates: candidates.length,
        skippedOutsideWindow,
        skippedNotReady,
        skippedAlreadyTitled,
        skippedDuplicate,
        limit: this.startupBackfillLimit,
        concurrency: this.startupBackfillConcurrency,
      },
      "[SessionTitleService] Startup title backfill scan completed",
    );

    let nextIndex = 0;
    let processed = 0;
    const workerCount = Math.min(
      this.startupBackfillConcurrency,
      candidates.length,
    );
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (!this.stopped && lifecycleId === this.lifecycleId) {
          const index = nextIndex;
          nextIndex += 1;
          const candidate = candidates[index];
          if (!candidate) return;
          await this.generateForSession(
            candidate.sessionId,
            candidate.projectId,
            "startup-backfill",
          );
          processed += 1;
        }
      }),
    );

    const titled = candidates.reduce((count, candidate) => {
      const metadata = this.metadataService.getMetadata(candidate.sessionId);
      return count + (metadata?.customTitle || metadata?.aiTitle ? 1 : 0);
    }, 0);
    log.info(
      {
        processed,
        titled,
        selectedCandidates: candidates.length,
        durationMs: Date.now() - startedAt,
        stopped: this.stopped || lifecycleId !== this.lifecycleId,
      },
      "[SessionTitleService] Startup title backfill finished",
    );
  }

  private getRetryDelayMs(
    failure: TitleModelFailure,
    failedAttempt: number,
  ): number {
    const exponentialDelay =
      this.retryBaseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
    return Math.min(
      this.retryMaxDelayMs,
      Math.max(exponentialDelay, failure.retryAfterMs ?? 0),
    );
  }

  private waitForRetry(delayMs: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.retryWaits.delete(timer);
        resolve(completed);
      };
      const timer = setTimeout(() => finish(true), delayMs);
      const unref = (timer as { unref?: () => void }).unref;
      if (typeof unref === "function") unref.call(timer);
      this.retryWaits.set(timer, () => finish(false));
    });
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
      attempt: number;
      maxAttempts: number;
    },
  ): Promise<string> {
    if (!this.apiKey) {
      throw new TitleModelRequestError(
        "title model API key is not configured",
        {
          retryable: false,
          kind: "configuration",
        },
      );
    }

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
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
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
    } catch (error) {
      throw new TitleModelRequestError(
        `title model network request failed: ${getErrorMessage(error)}`,
        {
          retryable: true,
          kind: isAbortError(error) ? "timeout" : "network",
        },
      );
    }

    if (!response.ok) {
      const body = await response
        .text()
        .then((value) => truncateForLog(value))
        .catch(() => "");
      throw new TitleModelRequestError(
        [
          `title model request failed: ${response.status} ${response.statusText}`,
          body ? `body=${body}` : null,
        ]
          .filter(Boolean)
          .join(" "),
        {
          retryable:
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          kind: "http",
          statusCode: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        },
      );
    }

    let payload: {
      id?: unknown;
      usage?: unknown;
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown; reasoning_content?: unknown };
      }>;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      throw new TitleModelRequestError(
        `title model returned invalid JSON: ${getErrorMessage(error)}`,
        {
          retryable: true,
          kind: "invalid-output",
        },
      );
    }
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
      throw new TitleModelRequestError(
        "title model response missing string content",
        {
          retryable: true,
          kind: "empty-output",
        },
      );
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
      throw new TitleModelRequestError(
        "title model response sanitized to an empty title",
        {
          retryable: true,
          kind: "invalid-output",
        },
      );
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
      throw new TitleModelRequestError(
        `title model response failed the ${requiredLanguage} language guard`,
        {
          retryable: true,
          kind: "invalid-output",
        },
      );
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

function toTitleModelFailure(error: unknown): TitleModelFailure {
  if (error instanceof TitleModelRequestError) return error;
  return { retryable: false, kind: "unexpected" };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const retryAt = new Date(value).getTime();
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
