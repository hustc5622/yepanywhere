import { type ChildProcess, spawn } from "node:child_process";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";
import type {
  AgentActivity,
  InputRequest,
  OpenCodeSessionConfig,
  PendingInputType,
  UrlProjectId,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { encodeProjectId } from "../projects/paths.js";
import { normalizeProviderGeneratedTitle } from "../sessions/provider-title-quality.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  type OpenCodeGatewayConfig,
  buildManagedOpenCodeEnv,
} from "./gateway-config.js";
import {
  isLiveOpenCodeBridgeSession,
  isLiveOpenCodeBridgeSessionView,
  opencodeBridgeOwnership,
} from "./session-state.js";
import type {
  OpenCodeBridgeController,
  OpenCodeBridgeInputResponse,
  OpenCodeBridgePendingInput,
  OpenCodeBridgeSession,
  OpenCodeBridgeSessionView,
  OpenCodeBridgeStatus,
} from "./types.js";

type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto";

type InputResponse = OpenCodeBridgeInputResponse;

interface OpenCodeBridgeServiceOptions {
  enabled: boolean;
  host: string;
  port: number;
  serverUrl: string;
  opencodeServerUrl?: string;
  opencodeStartPort?: number;
  opencodePath?: string;
  startupTimeoutMs?: number;
  desktopToken?: string;
  gatewayConfig?: OpenCodeGatewayConfig | null;
}

interface SessionRecord {
  id: string;
  projectId: UrlProjectId;
  cwd: string;
  serverUrl: string;
  desktopToken?: string;
  createdAt: string;
  updatedAt: string;
  processId?: string;
  model?: string;
  reasoningEffort?: string;
  mode?: PermissionMode;
  title?: string | null;
  messageCount?: number;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  active?: boolean;
}

interface StartSessionResponse {
  sessionId?: string;
  processId?: string;
  reasoningEffort?: string;
  queued?: boolean;
  queueId?: string;
  position?: number;
}

interface QueueMessageResponse {
  queued: boolean;
  restarted?: boolean;
  processId?: string;
}

interface ProcessInfoResponse {
  process: { id: string; state: string } | null;
}

interface InputRequestBody {
  requestId?: string;
  response?: InputResponse;
  answers?: UserQuestionAnswers;
  feedback?: string;
}

interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

interface ClientConfig {
  serverUrl: string;
  desktopToken?: string;
}

type OpenCodeQuestion = {
  id: string;
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
  custom?: boolean;
};

interface OpenCodeEvent {
  type?: unknown;
  properties?: unknown;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const OPENAI_GATEWAY_PATH_PREFIX = "/gateway/v1";

export class OpenCodeBridgeService implements OpenCodeBridgeController {
  private readonly enabled: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly defaultServerUrl: string;
  private readonly opencodeServerUrlOverride?: string;
  private readonly opencodeStartPort: number;
  private readonly opencodePath: string;
  private readonly startupTimeoutMs: number;
  private readonly defaultDesktopToken?: string;
  private readonly gatewayConfig?: OpenCodeGatewayConfig | null;

  private server: Server | null = null;
  private listening = false;
  private opencodeConnected = false;
  private opencodeProcess: ChildProcess | null = null;
  private opencodeServerUrl: string | null = null;
  private opencodeStartPromise: Promise<string> | null = null;
  private lastError: string | null = null;
  private sessions = new Map<string, SessionRecord>();
  private pendingInputs = new Map<string, OpenCodeBridgePendingInput>();
  private inputResponses = new Map<string, Promise<boolean>>();
  private eventAbortController: AbortController | null = null;
  private eventReconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: OpenCodeBridgeServiceOptions) {
    this.enabled = options.enabled;
    this.host = options.host;
    this.port = options.port;
    this.defaultServerUrl = normalizeUrl(options.serverUrl);
    this.opencodeServerUrlOverride = options.opencodeServerUrl
      ? normalizeUrl(options.opencodeServerUrl)
      : undefined;
    this.opencodeStartPort = options.opencodeStartPort ?? options.port + 1;
    this.opencodePath = options.opencodePath ?? "opencode";
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.defaultDesktopToken = options.desktopToken;
    this.gatewayConfig = options.gatewayConfig;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.server) return;

    const server = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.writeJson(res, 500, { error: message });
      });
    });

    this.server = server;
    await new Promise<void>((resolve) => {
      const onError = (error: Error) => {
        this.lastError = error.message;
        this.listening = false;
        this.server = null;
        console.warn(
          `[OpenCodeBridge] Failed to listen on http://${this.host}:${this.port}: ${error.message}`,
        );
        cleanup();
        resolve();
      };
      const onListening = () => {
        this.listening = true;
        this.lastError = null;
        console.log(
          `[OpenCodeBridge] Listening on http://${this.host}:${this.port}`,
        );
        cleanup();
        resolve();
      };
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });

    server.on("error", (error) => {
      this.lastError = error.message;
      console.warn(`[OpenCodeBridge] Server error: ${error.message}`);
    });

    if (this.listening) {
      this.startOpenCodeEventStream();
    }
  }

  async shutdown(): Promise<void> {
    this.stopOpenCodeEventStream();
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    this.listening = false;
    await this.stopManagedOpenCodeServer("shutdown");
  }

  getStatus(): OpenCodeBridgeStatus {
    return {
      enabled: this.enabled,
      listening: this.listening,
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}`,
      serverUrl: this.defaultServerUrl,
      opencodeServerUrl: this.getOpenCodeServerStatusUrl(),
      opencodeServerMode: this.opencodeServerUrlOverride
        ? "external"
        : "managed",
      opencodeServerRunning: this.isManagedOpenCodeServerRunning(),
      opencodeServerPid: this.opencodeServerUrlOverride
        ? null
        : (this.opencodeProcess?.pid ?? null),
      opencodeConnected: this.opencodeConnected,
      sessionCount: this.sessions.size,
      pendingInputCount: this.pendingInputs.size,
      lastError: this.lastError,
    };
  }

  listSessions(): OpenCodeBridgeSession[] {
    return Array.from(this.sessions.values())
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .map((session) => this.toBridgeSession(session));
  }

  listSessionViews(): OpenCodeBridgeSessionView[] {
    return this.listSessions().map((session) => this.toSessionView(session));
  }

  getSessionView(sessionId: string): OpenCodeBridgeSessionView | null {
    const record = this.sessions.get(sessionId);
    return record ? this.toSessionView(this.toBridgeSession(record)) : null;
  }

  isSessionActive(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    return record
      ? isLiveOpenCodeBridgeSession(this.toBridgeSession(record))
      : false;
  }

  getPendingInputRequest(sessionId: string): InputRequest | null {
    return this.pendingInputs.get(sessionId)?.request ?? null;
  }

  async respondToInput(
    sessionId: string,
    requestId: string,
    response: OpenCodeBridgeInputResponse,
    answers?: UserQuestionAnswers,
  ): Promise<boolean> {
    const responseKey = `${sessionId}\0${requestId}`;
    const existingResponse = this.inputResponses.get(responseKey);
    if (existingResponse) return existingResponse;

    const pending = this.pendingInputs.get(sessionId);
    if (!pending || pending.request.id !== requestId) return false;

    const operation = (async () => {
      if (pending.kind === "permission") {
        const reply =
          response === "deny"
            ? "reject"
            : response === "approve_always"
              ? "always"
              : "once";
        await this.postOpenCodeJson(`/permission/${requestId}/reply`, {
          reply,
        });
      } else {
        if (response === "deny") {
          await this.postOpenCodeJson(`/question/${requestId}/reject`);
        } else {
          await this.postOpenCodeJson(`/question/${requestId}/reply`, {
            answers: buildOpenCodeQuestionAnswers(pending.request, answers),
          });
        }
      }

      // The reply can synchronously unblock OpenCode and produce the next input
      // request before this HTTP response completes. Only consume the request
      // we actually answered; never delete a newer request for the session.
      if (this.pendingInputs.get(sessionId) === pending) {
        this.pendingInputs.delete(sessionId);
        this.updateSessionState(sessionId, {
          activity: "in-turn",
          pendingInputType: undefined,
          active: true,
        });
      }
      return true;
    })();
    this.inputResponses.set(responseKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inputResponses.get(responseKey) === operation) {
        this.inputResponses.delete(responseKey);
      }
    }
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.isLocalAddress(req.socket.remoteAddress ?? "")) {
      this.writeJson(res, 403, {
        error: "OpenCode bridge only accepts local connections",
      });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(`${OPENAI_GATEWAY_PATH_PREFIX}/`)) {
      await this.proxyOpenAICompatibleRequest(req, res, url);
      return;
    }
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (req.method === "GET" && url.pathname === "/readyz") {
      await this.syncOpenCodeRuntimeState();
      this.writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      await this.syncOpenCodeRuntimeState();
      this.writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      await this.syncOpenCodeRuntimeState();
      this.writeJson(res, 200, { sessions: this.listSessions() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/session-views") {
      await this.syncOpenCodeRuntimeState();
      this.writeJson(res, 200, { sessions: this.listSessionViews() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readJsonBody(req);
      const request = parseSessionRequest(body);
      if (!request.message) {
        this.writeJson(res, 400, { error: "message is required" });
        return;
      }
      const client = this.createClient(req, body);
      const projectId = encodeProjectId(request.cwd);
      const response = await client.startSession(projectId, request.message, {
        mode: request.mode,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        opencodeConfig: request.opencodeConfig,
      });
      if (response.sessionId) {
        this.recordSession(
          response.sessionId,
          projectId,
          request.cwd,
          this.getClientConfig(req, body),
          {
            processId: response.processId,
            model: request.model,
            reasoningEffort:
              response.reasoningEffort ?? request.reasoningEffort,
            mode: request.mode,
          },
        );
      }
      this.writeJson(res, response.queued ? 202 : 200, response);
      return;
    }

    if (parts[0] === "sessions" && parts[1]) {
      const sessionId = parts[1];
      if (req.method === "GET" && parts[2] === "view") {
        await this.syncOpenCodeRuntimeState();
        this.writeJson(res, 200, {
          sessionView: this.getSessionView(sessionId),
        });
        return;
      }

      if (req.method === "GET" && parts[2] === "active") {
        await this.syncOpenCodeRuntimeState();
        this.writeJson(res, 200, {
          active: this.isSessionActive(sessionId),
        });
        return;
      }

      if (req.method === "GET" && parts.length === 2) {
        const { client, projectId, cwd } = this.resolveSessionTarget(
          sessionId,
          url,
          req,
        );
        const detail = await client.getSession(projectId, sessionId);
        this.recordSession(
          sessionId,
          projectId,
          cwd,
          this.getClientConfig(req, undefined, this.sessions.get(sessionId)),
          {},
        );
        this.writeJson(res, 200, detail);
        return;
      }

      if (req.method === "GET" && parts[2] === "process") {
        const client = this.resolveClient(sessionId, req);
        this.writeJson(res, 200, await client.getProcessInfo(sessionId));
        return;
      }

      if (req.method === "GET" && parts[2] === "pending-input") {
        await this.syncOpenCodeRuntimeState();
        this.writeJson(res, 200, {
          request: this.getPendingInputRequest(sessionId),
        });
        return;
      }

      if (req.method === "POST" && parts[2] === "resume") {
        const body = await readJsonBody(req);
        const request = parseSessionRequest(body);
        if (!request.message) {
          this.writeJson(res, 400, { error: "message is required" });
          return;
        }
        const client = this.createClient(req, body);
        const projectId = encodeProjectId(request.cwd);
        const response = await client.resumeSession(
          projectId,
          sessionId,
          request.message,
          {
            mode: request.mode,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            opencodeConfig: request.opencodeConfig,
            resumeSessionAt: request.resumeSessionAt,
          },
        );
        const responseSessionId = response.sessionId ?? sessionId;
        this.recordSession(
          responseSessionId,
          projectId,
          request.cwd,
          this.getClientConfig(req, body),
          {
            processId: response.processId,
            model: request.model,
            reasoningEffort:
              response.reasoningEffort ?? request.reasoningEffort,
            mode: request.mode,
          },
        );
        this.writeJson(res, response.queued ? 202 : 200, response);
        return;
      }

      if (req.method === "POST" && parts[2] === "messages") {
        const body = await readJsonBody(req);
        const request = parseSessionRequest(body);
        if (!request.message) {
          this.writeJson(res, 400, { error: "message is required" });
          return;
        }
        const client = this.createClient(req, body);
        const response = await client.queueMessage(sessionId, request.message, {
          mode: request.mode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          opencodeConfig: request.opencodeConfig,
        });
        this.touchSession(sessionId, {
          processId: response.processId,
          reasoningEffort: request.reasoningEffort,
        });
        this.writeJson(res, 200, response);
        return;
      }

      if (req.method === "POST" && parts[2] === "input") {
        const body = (await readJsonBody(req)) as InputRequestBody | null;
        if (!body?.requestId || !body.response) {
          this.writeJson(res, 400, {
            error: "requestId and response are required",
          });
          return;
        }
        const responseKey = `${sessionId}\0${body.requestId}`;
        if (!this.inputResponses.has(responseKey)) {
          await this.syncOpenCodeRuntimeState();
        }
        const accepted = await this.respondToInput(
          sessionId,
          body.requestId,
          body.response,
          body.answers,
        );
        if (accepted) {
          this.writeJson(res, 200, {
            accepted,
          });
          return;
        }
        const client = this.createClient(req, body);
        this.writeJson(res, 200, {
          accepted: (
            await client.respondToInput(
              sessionId,
              body.requestId,
              body.response,
              body.answers,
              body.feedback,
            )
          ).accepted,
        });
        return;
      }
    }

    this.writeJson(res, 404, { error: "Not found" });
  }

  private createClient(req?: IncomingMessage, raw?: unknown): YepApiClient {
    const config = this.getClientConfig(req, raw);
    return new YepApiClient(config.serverUrl, config.desktopToken);
  }

  private resolveClient(sessionId: string, req: IncomingMessage): YepApiClient {
    const record = this.sessions.get(sessionId);
    const config = this.getClientConfig(req, undefined, record);
    return new YepApiClient(config.serverUrl, config.desktopToken);
  }

  private getClientConfig(
    req?: IncomingMessage,
    raw?: unknown,
    fallback?: ClientConfig,
  ): ClientConfig {
    const body = asRecord(raw);
    const headerServerUrl = readHeader(req, "x-yep-server-url");
    const headerDesktopToken = readHeader(req, "x-desktop-token");
    const serverUrl =
      typeof body?.serverUrl === "string"
        ? body.serverUrl
        : (headerServerUrl ?? fallback?.serverUrl ?? this.defaultServerUrl);
    const desktopToken =
      typeof body?.desktopToken === "string"
        ? body.desktopToken
        : (headerDesktopToken ??
          fallback?.desktopToken ??
          this.defaultDesktopToken);
    return { serverUrl, desktopToken };
  }

  private resolveSessionTarget(
    sessionId: string,
    url: URL,
    req: IncomingMessage,
  ): { client: YepApiClient; projectId: UrlProjectId; cwd: string } {
    const record = this.sessions.get(sessionId);
    const cwd = url.searchParams.get("cwd") ?? record?.cwd ?? process.cwd();
    const projectId =
      (url.searchParams.get("projectId") as UrlProjectId | null) ??
      record?.projectId ??
      encodeProjectId(cwd);
    const config = this.getClientConfig(req, undefined, record);
    return {
      client: new YepApiClient(config.serverUrl, config.desktopToken),
      projectId,
      cwd,
    };
  }

  private recordSession(
    sessionId: string,
    projectId: UrlProjectId,
    cwd: string,
    clientConfig: ClientConfig,
    metadata: {
      processId?: string;
      model?: string;
      reasoningEffort?: string;
      mode?: PermissionMode;
    },
  ): void {
    const now = new Date().toISOString();
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      id: sessionId,
      projectId,
      cwd,
      serverUrl: clientConfig.serverUrl,
      desktopToken: clientConfig.desktopToken,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      processId: metadata.processId ?? existing?.processId,
      model: metadata.model ?? existing?.model,
      reasoningEffort: metadata.reasoningEffort ?? existing?.reasoningEffort,
      mode: metadata.mode ?? existing?.mode,
      title: existing?.title,
      messageCount: existing?.messageCount,
      activity: existing?.activity,
      pendingInputType: existing?.pendingInputType,
      active: existing?.active,
    });
  }

  private touchSession(
    sessionId: string,
    metadata: { processId?: string; reasoningEffort?: string },
  ): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.updatedAt = new Date().toISOString();
    existing.processId = metadata.processId ?? existing.processId;
    existing.reasoningEffort =
      metadata.reasoningEffort ?? existing.reasoningEffort;
  }

  private updateSessionState(
    sessionId: string,
    state: Partial<
      Pick<
        SessionRecord,
        | "title"
        | "messageCount"
        | "activity"
        | "pendingInputType"
        | "active"
        | "updatedAt"
      >
    >,
  ): void {
    const existing = this.sessions.get(sessionId);
    const now = new Date().toISOString();
    if (existing) {
      const stateChanged = Object.entries(state).some(
        ([key, value]) => existing[key as keyof SessionRecord] !== value,
      );
      if (!stateChanged) return;

      // Runtime status polling is not session content. Preserve the timestamp
      // supplied by OpenCode and do not manufacture a fresh updatedAt merely
      // because a repeated busy/idle poll arrived.
      Object.assign(existing, state);
      return;
    }

    const cwd = process.cwd();
    this.sessions.set(sessionId, {
      id: sessionId,
      projectId: encodeProjectId(cwd),
      cwd,
      serverUrl: this.defaultServerUrl,
      desktopToken: this.defaultDesktopToken,
      createdAt: now,
      updatedAt: state.updatedAt ?? now,
      title: state.title,
      messageCount: state.messageCount,
      activity: state.activity,
      pendingInputType: state.pendingInputType,
      active: state.active,
    });
  }

  private toBridgeSession(record: SessionRecord): OpenCodeBridgeSession {
    const projectName = path.basename(record.cwd) || record.cwd;
    return {
      id: record.id,
      projectId: record.projectId,
      projectPath: record.cwd,
      projectName,
      title: record.title ?? null,
      fullTitle: record.title ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount ?? 1,
      provider: "opencode",
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      activity: record.activity,
      pendingInputType: record.pendingInputType,
      active:
        record.active ??
        (record.activity === "in-turn" || record.activity === "waiting-input"),
    };
  }

  private toSessionView(
    session: OpenCodeBridgeSession,
  ): OpenCodeBridgeSessionView {
    const view: OpenCodeBridgeSessionView = {
      session: {
        id: session.id,
        projectId: session.projectId,
        title: session.title,
        fullTitle: session.fullTitle,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
        ownership: opencodeBridgeOwnership(
          isLiveOpenCodeBridgeSession(session),
        ),
        pendingInputType: session.pendingInputType,
        activity: session.activity,
        provider: "opencode",
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        source: "opencode-bridge",
      } satisfies SessionSummary,
      projectName: session.projectName,
      activity: session.activity,
      pendingInputType: session.pendingInputType,
    };
    return {
      ...view,
      session: {
        ...view.session,
        ownership: opencodeBridgeOwnership(
          isLiveOpenCodeBridgeSessionView(view),
        ),
      },
    };
  }

  private startOpenCodeEventStream(): void {
    if (!this.enabled || this.eventAbortController) return;
    this.eventAbortController = new AbortController();
    void this.consumeOpenCodeEvents(this.eventAbortController.signal);
  }

  private stopOpenCodeEventStream(): void {
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = null;
    }
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.opencodeConnected = false;
  }

  private scheduleOpenCodeEventReconnect(): void {
    if (!this.enabled || this.eventAbortController?.signal.aborted) return;
    if (this.eventReconnectTimer) return;
    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = null;
      const controller = this.eventAbortController;
      if (!controller || controller.signal.aborted) return;
      void this.consumeOpenCodeEvents(controller.signal);
    }, 1_000);
  }

  private async consumeOpenCodeEvents(signal: AbortSignal): Promise<void> {
    try {
      const opencodeServerUrl = await this.ensureOpenCodeServerUrl();
      if (signal.aborted) return;
      const response = await fetch(`${opencodeServerUrl}/global/event`, {
        headers: { accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream returned ${response.status}`);
      }

      this.opencodeConnected = true;
      this.lastError = null;
      await this.syncOpenCodeRuntimeState(opencodeServerUrl);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          this.handleSseLine(line);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.opencodeConnected = false;
      if (!signal.aborted) this.scheduleOpenCodeEventReconnect();
    }
  }

  private handleSseLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") return;
    try {
      const event = unwrapOpenCodeEvent(JSON.parse(data));
      if (event) this.handleOpenCodeEvent(event);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private handleOpenCodeEvent(event: OpenCodeEvent): void {
    const type = typeof event.type === "string" ? event.type : "";
    const properties = asRecord(event.properties);
    const sessionId =
      readString(properties, "sessionID") ??
      readString(properties, "sessionId");
    if (!sessionId) return;

    if (type === "session.idle") {
      this.updateSessionState(sessionId, {
        activity: "idle",
        pendingInputType: undefined,
        active: false,
      });
      return;
    }

    if (type === "session.status") {
      const status = readOpenCodeStatusType(properties?.status);
      this.updateSessionState(sessionId, {
        activity: status === "idle" ? "idle" : "in-turn",
        active: status !== "idle",
      });
      return;
    }

    if (
      type === "session.created" ||
      type === "session.updated" ||
      type === "message.updated" ||
      type === "message.part.updated" ||
      type === "message.part.delta"
    ) {
      this.recordOpenCodeSessionEvent(sessionId, properties);
      return;
    }

    if (type === "permission.asked" || type === "permission.v2.asked") {
      this.recordOpenCodePermissionRequest(sessionId, properties);
      return;
    }

    if (type === "permission.replied" || type === "permission.v2.replied") {
      this.clearOpenCodePendingInput(sessionId, properties);
      return;
    }

    if (type === "question.asked" || type === "question.v2.asked") {
      this.recordOpenCodeQuestionRequest(sessionId, properties);
      return;
    }

    if (
      type === "question.replied" ||
      type === "question.rejected" ||
      type === "question.v2.replied" ||
      type === "question.v2.rejected"
    ) {
      this.clearOpenCodePendingInput(sessionId, properties);
    }
  }

  private recordOpenCodeSessionEvent(
    sessionId: string,
    properties: Record<string, unknown> | null,
  ): void {
    const info = asRecord(properties?.info);
    const title = normalizeProviderGeneratedTitle(readString(info, "title"));
    const updatedAt =
      readOpenCodeUpdatedAt(info) ??
      readString(info, "updatedAt") ??
      readString(properties, "updatedAt");
    const messageCount = readNumber(info, "messageCount");
    this.updateSessionState(sessionId, {
      // Message events do not include a session title. Avoid replacing the
      // title recorded from session.created with undefined in that case.
      ...(title ? { title } : {}),
      ...(messageCount !== undefined ? { messageCount } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      activity: "in-turn",
      active: true,
    });
  }

  private recordOpenCodePermissionRequest(
    sessionId: string,
    properties: Record<string, unknown> | null,
  ): void {
    const requestId =
      readString(properties, "id") ?? readString(properties, "requestID");
    if (!requestId) return;
    const permission = readString(properties, "permission") ?? "permission";
    const patterns = readStringArray(properties?.patterns);
    const prompt = `Allow ${permission}${patterns.length ? ` ${patterns.join(", ")}` : ""}?`;
    const timestamp = new Date().toISOString();
    this.pendingInputs.set(sessionId, {
      requestId,
      kind: "permission",
      raw: properties,
      createdAt: timestamp,
      request: {
        id: requestId,
        sessionId,
        type: "tool-approval",
        prompt,
        options: ["Approve", "Deny"],
        toolName: "OpenCode",
        toolInput: {
          approvalKind: "opencode_permission",
          permission,
          patterns,
          metadata: properties?.metadata,
          raw: properties,
        },
        timestamp,
        source: "opencode-bridge",
      },
    });
    this.updateSessionState(sessionId, {
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      active: true,
    });
  }

  private recordOpenCodeQuestionRequest(
    sessionId: string,
    properties: Record<string, unknown> | null,
  ): void {
    const requestId =
      readString(properties, "id") ?? readString(properties, "requestID");
    const questions = normalizeOpenCodeQuestions(properties?.questions);
    if (!requestId || questions.length === 0) return;
    const timestamp = new Date().toISOString();
    this.pendingInputs.set(sessionId, {
      requestId,
      kind: "question",
      raw: properties,
      createdAt: timestamp,
      request: {
        id: requestId,
        sessionId,
        type: "question",
        prompt: questions[0]?.question ?? "Question",
        toolName: "AskUserQuestion",
        toolInput: {
          questions,
          opencodeQuestions: properties?.questions,
          raw: properties,
        },
        timestamp,
        source: "opencode-bridge",
      },
    });
    this.updateSessionState(sessionId, {
      activity: "waiting-input",
      pendingInputType: "user-question",
      active: true,
    });
  }

  private clearOpenCodePendingInput(
    sessionId: string,
    properties: Record<string, unknown> | null,
  ): void {
    const requestId =
      readString(properties, "requestID") ?? readString(properties, "id");
    if (!requestId) return;
    const pending = this.pendingInputs.get(sessionId);
    if (pending) {
      if (pending.requestId !== requestId) return;
      this.pendingInputs.delete(sessionId);
    }
    this.updateSessionState(sessionId, {
      activity: "in-turn",
      pendingInputType: undefined,
      active: true,
    });
  }

  private async postOpenCodeJson(
    pathname: string,
    body?: unknown,
  ): Promise<void> {
    const opencodeServerUrl = await this.ensureOpenCodeServerUrl();
    const response = await fetch(`${opencodeServerUrl}${pathname}`, {
      method: "POST",
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const body = await readResponseBody(response);
      const message = formatApiError(response.status, body);
      throw new Error(message);
    }
  }

  private async syncOpenCodeRuntimeState(baseUrl?: string): Promise<void> {
    try {
      const opencodeServerUrl =
        baseUrl ?? (await this.ensureOpenCodeServerUrl());
      await Promise.all([
        this.syncOpenCodeSessionStatus(opencodeServerUrl),
        this.syncOpenCodePendingQuestions(opencodeServerUrl),
      ]);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async syncOpenCodeSessionStatus(baseUrl?: string): Promise<void> {
    const opencodeServerUrl = baseUrl ?? (await this.ensureOpenCodeServerUrl());
    const response = await fetch(`${opencodeServerUrl}/session/status`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(formatApiError(response.status, body));
    }

    const body = await response.json();
    const activeStatus = asRecord(body) ?? {};
    const activeSessionIds = new Set(Object.keys(activeStatus));
    for (const sessionId of activeSessionIds) {
      const statusType = readOpenCodeStatusType(activeStatus[sessionId]);
      this.updateSessionState(sessionId, {
        activity: statusType === "idle" ? "idle" : "in-turn",
        active: statusType !== "idle",
      });
    }

    for (const [sessionId, record] of this.sessions) {
      if (record.activity === "waiting-input") continue;
      if (activeSessionIds.has(sessionId)) continue;
      this.updateSessionState(sessionId, {
        activity: "idle",
        pendingInputType: undefined,
        active: false,
      });
    }
  }

  private async syncOpenCodePendingQuestions(baseUrl?: string): Promise<void> {
    const opencodeServerUrl = baseUrl ?? (await this.ensureOpenCodeServerUrl());
    const response = await fetch(`${opencodeServerUrl}/question`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(formatApiError(response.status, body));
    }

    const body = await response.json();
    const bodyRecord = asRecord(body);
    const requests: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(bodyRecord?.data)
        ? bodyRecord.data
        : [];
    const seen = new Set<string>();
    for (const item of requests) {
      const record = asRecord(item);
      const sessionId =
        readString(record, "sessionID") ?? readString(record, "sessionId");
      const requestId =
        readString(record, "id") ?? readString(record, "requestID");
      if (!sessionId || !requestId) continue;
      this.recordOpenCodeQuestionRequest(sessionId, {
        ...record,
        id: requestId,
      });
      seen.add(`${sessionId}:${requestId}`);
    }

    for (const [sessionId, pending] of this.pendingInputs) {
      if (
        pending.kind === "question" &&
        !seen.has(`${sessionId}:${pending.requestId}`)
      ) {
        this.pendingInputs.delete(sessionId);
        this.updateSessionState(sessionId, {
          activity: "in-turn",
          pendingInputType: undefined,
          active: true,
        });
      }
    }
  }

  private async ensureOpenCodeServerUrl(): Promise<string> {
    if (this.opencodeServerUrlOverride) return this.opencodeServerUrlOverride;
    if (this.opencodeServerUrl && this.isManagedOpenCodeServerRunning()) {
      return this.opencodeServerUrl;
    }
    if (this.opencodeStartPromise) {
      return this.opencodeStartPromise;
    }

    this.opencodeStartPromise = this.startManagedOpenCodeServer().finally(
      () => {
        this.opencodeStartPromise = null;
      },
    );
    return this.opencodeStartPromise;
  }

  private async startManagedOpenCodeServer(): Promise<string> {
    const port = await findAvailablePort(this.opencodeStartPort);
    const url = `http://127.0.0.1:${port}`;
    const spawnArgs = [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--print-logs",
    ];
    console.log(
      `[OpenCodeBridge] Starting managed OpenCode server path=${this.opencodePath} args=${JSON.stringify(spawnArgs)}`,
    );
    const child = spawn(this.opencodePath, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildManagedOpenCodeEnv(process.env, this.gatewayConfig, {
        openAICompatibleBaseURL: this.getOpenAICompatibleGatewayUrl(),
      }),
    });
    this.opencodeProcess = child;
    this.opencodeServerUrl = url;
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        reject(
          new Error(
            `Failed to start OpenCode server with ${this.opencodePath}: ${error.message}`,
          ),
        );
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.debug(`[OpenCodeBridge upstream] ${text}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.debug(`[OpenCodeBridge upstream] ${text}`);
    });
    child.once("exit", (code, signal) => {
      if (this.opencodeProcess === child) {
        this.opencodeProcess = null;
        this.opencodeServerUrl = null;
      }
      console.log(
        `[OpenCodeBridge] Managed OpenCode server exited code=${String(code)} signal=${String(signal)}`,
      );
    });

    try {
      await Promise.race([
        waitForOpenCodeHealth(url, this.startupTimeoutMs),
        spawnErrorPromise,
      ]);
    } catch (error) {
      if (this.opencodeProcess === child) {
        this.opencodeProcess = null;
        this.opencodeServerUrl = null;
      }
      if (child.pid && child.exitCode === null && !child.killed) {
        try {
          console.warn(
            `[OpenCodeBridge] Stopping managed OpenCode server reason=startup-failed pid=${child.pid}`,
          );
          process.kill(process.platform !== "win32" ? -child.pid : child.pid);
        } catch {}
      }
      throw error;
    }

    this.lastError = null;
    console.log(`[OpenCodeBridge] Managed OpenCode server ready at ${url}`);
    return url;
  }

  private getOpenAICompatibleGatewayUrl(): string {
    return `http://127.0.0.1:${this.port}${OPENAI_GATEWAY_PATH_PREFIX}`;
  }

  private async proxyOpenAICompatibleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const gateway = this.gatewayConfig;
    if (!gateway) {
      this.writeJson(res, 503, {
        error: "OpenAI-compatible gateway is not configured",
      });
      return;
    }

    const suffix = url.pathname.slice(OPENAI_GATEWAY_PATH_PREFIX.length);
    const upstreamUrl = `${gateway.apiBase}${suffix}${url.search}`;
    const requestBody = await readRequestBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        name === "host" ||
        name === "connection" ||
        name === "content-length" ||
        name === "accept-encoding"
      ) {
        continue;
      }
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    if (gateway.subModule) {
      headers.set("X-Sub-Module", gateway.subModule);
    }
    if (process.env.YEP_OPENCODE_GATEWAY_DEBUG === "true") {
      console.log(
        "[OpenCodeBridge gateway]",
        JSON.stringify({
          ...summarizeOpenAICompatibleBody(requestBody),
          method: req.method,
          path: suffix,
          hasAuthorization: headers.has("authorization"),
          subModule: headers.get("x-sub-module"),
        }),
      );
    }

    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body:
          requestBody.length > 0 ? requestBody.toString("utf-8") : undefined,
      });
      // GLM's Chat Completions stream is valid SSE, but its very small chunks
      // trigger an OpenCode AI SDK decoding bug around tool calls. Buffering
      // only this local compatibility route preserves the exact SSE payload
      // while presenting it as one coherent body to OpenCode.
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(responseBody);
    } catch (error) {
      this.writeJson(res, 502, {
        error: `OpenAI-compatible gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async stopManagedOpenCodeServer(reason: string): Promise<void> {
    this.opencodeStartPromise = null;
    if (this.opencodeServerUrlOverride) return;

    const child = this.opencodeProcess;
    this.opencodeProcess = null;
    this.opencodeServerUrl = null;
    if (!child?.pid || child.exitCode !== null || child.killed) {
      return;
    }

    const pid = process.platform !== "win32" ? -child.pid : child.pid;
    try {
      console.log(
        `[OpenCodeBridge] Stopping managed OpenCode server reason=${reason} pid=${child.pid}`,
      );
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private isManagedOpenCodeServerRunning(): boolean {
    if (this.opencodeServerUrlOverride) return false;
    const child = this.opencodeProcess;
    return !!child && !child.killed && child.exitCode === null;
  }

  private getOpenCodeServerStatusUrl(): string {
    return (
      this.opencodeServerUrlOverride ??
      this.opencodeServerUrl ??
      `http://127.0.0.1:${this.opencodeStartPort}`
    );
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private isLocalAddress(address: string): boolean {
    return (
      address === "127.0.0.1" ||
      address === "::1" ||
      address === "::ffff:127.0.0.1" ||
      address === "localhost"
    );
  }
}

function summarizeOpenAICompatibleBody(body: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body.toString("utf-8")) as Record<
      string,
      unknown
    >;
    return {
      model: parsed.model,
      stream: parsed.stream,
      maxTokens: parsed.max_tokens,
      messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
      toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      toolChoice: parsed.tool_choice,
      requestKeys: Object.keys(parsed).sort(),
    };
  } catch {
    return { invalidJsonBody: true };
  }
}

class YepApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly desktopToken: string | undefined,
  ) {}

  startSession(
    projectId: string,
    message: string,
    options: {
      mode?: PermissionMode;
      model?: string;
      reasoningEffort?: string;
      opencodeConfig?: OpenCodeSessionConfig;
    },
  ): Promise<StartSessionResponse> {
    return this.request(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        opencodeConfig: options.opencodeConfig,
        provider: "opencode",
      },
    });
  }

  async resumeSession(
    projectId: string,
    sessionId: string,
    message: string,
    options: {
      mode?: PermissionMode;
      model?: string;
      reasoningEffort?: string;
      opencodeConfig?: OpenCodeSessionConfig;
      resumeSessionAt?: string;
    },
  ): Promise<StartSessionResponse> {
    const response = await this.request<StartSessionResponse>(
      `/api/projects/${projectId}/sessions/${sessionId}/resume`,
      {
        method: "POST",
        body: {
          message,
          mode: options.mode,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          opencodeConfig: options.opencodeConfig,
          resumeSessionAt: options.resumeSessionAt,
          provider: "opencode",
        },
      },
    );
    return { sessionId, ...response };
  }

  getSession(
    projectId: string,
    sessionId: string,
  ): Promise<{ pendingInputRequest?: unknown }> {
    return this.request(`/api/projects/${projectId}/sessions/${sessionId}`);
  }

  getProcessInfo(sessionId: string): Promise<ProcessInfoResponse> {
    return this.request(`/api/sessions/${sessionId}/process`);
  }

  queueMessage(
    sessionId: string,
    message: string,
    options: {
      mode?: PermissionMode;
      model?: string;
      reasoningEffort?: string;
      opencodeConfig?: OpenCodeSessionConfig;
    },
  ): Promise<QueueMessageResponse> {
    return this.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        opencodeConfig: options.opencodeConfig,
        provider: "opencode",
      },
    });
  }

  respondToInput(
    sessionId: string,
    requestId: string,
    response: InputResponse,
    answers?: UserQuestionAnswers,
    feedback?: string,
  ): Promise<{ accepted: boolean }> {
    return this.request(`/api/sessions/${sessionId}/input`, {
      method: "POST",
      body: { requestId, response, answers, feedback },
    });
  }

  private async request<T>(
    pathname: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const response = await fetch(`${normalizeUrl(this.serverUrl)}${pathname}`, {
      method: init?.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-yep-anywhere": "true",
        ...(this.desktopToken ? { "x-desktop-token": this.desktopToken } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!response.ok) {
      const body = await readResponseBody(response);
      const error = new Error(
        formatApiError(response.status, body),
      ) as ApiError;
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return (await response.json()) as T;
  }
}

function parseSessionRequest(raw: unknown): {
  cwd: string;
  message?: string;
  mode?: PermissionMode;
  model?: string;
  reasoningEffort?: string;
  opencodeConfig?: OpenCodeSessionConfig;
  resumeSessionAt?: string;
} {
  const body = asRecord(raw);
  const cwd =
    typeof body?.cwd === "string" ? path.resolve(body.cwd) : process.cwd();
  const message = typeof body?.message === "string" ? body.message : undefined;
  const mode =
    typeof body?.mode === "string" && isPermissionMode(body.mode)
      ? body.mode
      : undefined;
  const model = typeof body?.model === "string" ? body.model : undefined;
  const reasoningEffort =
    typeof body?.reasoningEffort === "string"
      ? body.reasoningEffort
      : undefined;
  const opencodeConfig = asRecord(body?.opencodeConfig)
    ? (body?.opencodeConfig as OpenCodeSessionConfig)
    : undefined;
  const resumeSessionAt =
    typeof body?.resumeSessionAt === "string"
      ? body.resumeSessionAt
      : undefined;
  return {
    cwd,
    message,
    mode,
    model,
    reasoningEffort,
    opencodeConfig,
    resumeSessionAt,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(req);
  if (body.length === 0) return null;
  const text = body.toString("utf-8");
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = Math.max(1, startPort); port < startPort + 100; port++) {
    if (await isPortAvailable("127.0.0.1", port)) {
      return port;
    }
  }
  throw new Error(`No available port found near ${startPort}`);
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function waitForOpenCodeHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/global/health`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for OpenCode server at ${baseUrl}: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

function formatApiError(status: number, body: unknown): string {
  const record = asRecord(body);
  const message = record?.error;
  return typeof message === "string"
    ? `Yep API error ${status}: ${message}`
    : `Yep API error ${status}`;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "auto"
  );
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function readHeader(
  req: IncomingMessage | undefined,
  name: string,
): string | null {
  const value = req?.headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapOpenCodeEvent(value: unknown): OpenCodeEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  const payload = asRecord(record.payload);
  const event = payload ?? record;
  return typeof event.type === "string" ? (event as OpenCodeEvent) : null;
}

function readString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * OpenCode session events carry their authoritative timestamp in
 * properties.info.time.updated (milliseconds since epoch). Older bridge
 * versions looked for info.updatedAt instead and replaced it with the local
 * clock, causing every runtime status poll to look like new session content.
 */
function readOpenCodeUpdatedAt(
  info: Record<string, unknown> | null,
): string | null {
  const time = asRecord(info?.time);
  const updated = readNumber(time, "updated");
  if (updated === undefined) return null;
  return new Date(updated).toISOString();
}

function readNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readOpenCodeStatusType(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return readString(record, "type") ?? "running";
}

function normalizeOpenCodeQuestions(raw: unknown): OpenCodeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: OpenCodeQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item);
    const question = readString(record, "question");
    if (!question) continue;

    const options = Array.isArray(record?.options)
      ? record.options
          .map((option) => {
            const optionRecord = asRecord(option);
            const label = readString(optionRecord, "label");
            if (!label) return null;
            return {
              label,
              description: readString(optionRecord, "description") ?? "",
            };
          })
          .filter(
            (option): option is { label: string; description: string } =>
              option !== null,
          )
      : [];

    questions.push({
      id: `question-${index}`,
      question,
      header: readString(record, "header") ?? "Question",
      options,
      multiSelect: Boolean(record?.multiSelect ?? record?.multiple),
      ...(typeof record?.custom === "boolean" ? { custom: record.custom } : {}),
    });
  }
  return questions;
}

function buildOpenCodeQuestionAnswers(
  request: InputRequest,
  answers: UserQuestionAnswers | undefined,
): string[][] {
  const input = asRecord(request.toolInput);
  const questions = normalizeOpenCodeQuestions(input?.questions);
  return questions.map((question) => {
    const answer = answers?.[question.id] ?? answers?.[question.question];
    if (typeof answer === "string") return answer ? [answer] : [];
    if (Array.isArray(answer)) return answer.filter(Boolean);
    return [];
  });
}
