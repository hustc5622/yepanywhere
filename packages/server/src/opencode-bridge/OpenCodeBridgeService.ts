import { type Server, type ServerResponse, createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { encodeProjectId } from "../projects/paths.js";

type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto";

type InputResponse = "approve" | "approve_accept_edits" | "deny";

interface OpenCodeBridgeServiceOptions {
  enabled: boolean;
  host: string;
  port: number;
  serverUrl: string;
  desktopToken?: string;
}

interface OpenCodeBridgeStatus {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  url: string;
  serverUrl: string;
  sessionCount: number;
  lastError: string | null;
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
  mode?: PermissionMode;
}

type PublicSessionRecord = Omit<SessionRecord, "desktopToken">;

interface StartSessionResponse {
  sessionId?: string;
  processId?: string;
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
  answers?: Record<string, string>;
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

export class OpenCodeBridgeService {
  private readonly enabled: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly defaultServerUrl: string;
  private readonly defaultDesktopToken?: string;

  private server: Server | null = null;
  private listening = false;
  private lastError: string | null = null;
  private sessions = new Map<string, SessionRecord>();

  constructor(options: OpenCodeBridgeServiceOptions) {
    this.enabled = options.enabled;
    this.host = options.host;
    this.port = options.port;
    this.defaultServerUrl = normalizeUrl(options.serverUrl);
    this.defaultDesktopToken = options.desktopToken;
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
  }

  async shutdown(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    this.listening = false;
  }

  getStatus(): OpenCodeBridgeStatus {
    return {
      enabled: this.enabled,
      listening: this.listening,
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}`,
      serverUrl: this.defaultServerUrl,
      sessionCount: this.sessions.size,
      lastError: this.lastError,
    };
  }

  listSessions(): PublicSessionRecord[] {
    return Array.from(this.sessions.values())
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .map(({ desktopToken: _desktopToken, ...session }) => session);
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
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (req.method === "GET" && url.pathname === "/readyz") {
      this.writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      this.writeJson(res, 200, this.getStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      this.writeJson(res, 200, { sessions: this.listSessions() });
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
            mode: request.mode,
          },
        );
      }
      this.writeJson(res, response.queued ? 202 : 200, response);
      return;
    }

    if (parts[0] === "sessions" && parts[1]) {
      const sessionId = parts[1];
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
        const { client, projectId } = this.resolveSessionTarget(
          sessionId,
          url,
          req,
        );
        const detail = await client.getSession(projectId, sessionId);
        this.writeJson(res, 200, {
          request: detail.pendingInputRequest ?? null,
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
        });
        this.touchSession(sessionId, { processId: response.processId });
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
      mode: metadata.mode ?? existing?.mode,
    });
  }

  private touchSession(
    sessionId: string,
    metadata: { processId?: string },
  ): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.updatedAt = new Date().toISOString();
    existing.processId = metadata.processId ?? existing.processId;
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

class YepApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly desktopToken: string | undefined,
  ) {}

  startSession(
    projectId: string,
    message: string,
    options: { mode?: PermissionMode; model?: string },
  ): Promise<StartSessionResponse> {
    return this.request(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
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
    options: { mode?: PermissionMode; model?: string },
  ): Promise<QueueMessageResponse> {
    return this.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        provider: "opencode",
      },
    });
  }

  respondToInput(
    sessionId: string,
    requestId: string,
    response: InputResponse,
    answers?: Record<string, string>,
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
  const resumeSessionAt =
    typeof body?.resumeSessionAt === "string"
      ? body.resumeSessionAt
      : undefined;
  return { cwd, message, mode, model, resumeSessionAt };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
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
