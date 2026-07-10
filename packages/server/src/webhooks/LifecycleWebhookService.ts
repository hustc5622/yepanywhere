import { basename } from "node:path";
import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { RuntimeController } from "../runtime/types.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { decodeProjectId } from "../supervisor/types.js";
import type {
  BusEvent,
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
} from "../watcher/index.js";

interface SessionInactiveWebhookPayload {
  type: "session-inactive";
  timestamp: string;
  session: {
    id: string;
  };
  project: {
    id: UrlProjectId;
    path: string;
    name: string;
  };
  process?: {
    id: string;
    provider?: ProviderName;
    model?: string;
    executor?: string;
    permissionMode?: string;
  };
  reason?: "idle" | "error";
  summary?: string;
  lastUserMessageText?: string;
  lastMessageText?: string;
  dryRun: boolean;
}

export interface LifecycleWebhookServiceOptions {
  eventBus: EventBus;
  runtimeController?: Pick<RuntimeController, "getProcessSnapshotForSession">;
  supervisor?: Supervisor;
  serverSettingsService: ServerSettingsService;
}

interface WebhookProcessView {
  id: string;
  state: string | { type: string };
  projectPath: string;
  provider: ProviderName;
  model?: string;
  resolvedModel?: string;
  executor?: string;
  permissionMode?: string;
  messageHistory?: Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }>;
  getMessageHistory?: () => Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }>;
}

export class LifecycleWebhookService {
  private readonly unsubscribe: () => void;

  constructor(private readonly options: LifecycleWebhookServiceOptions) {
    this.unsubscribe = this.options.eventBus.subscribe((event) => {
      void this.handleEvent(event);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  private async handleEvent(event: BusEvent): Promise<void> {
    if (event.type === "process-state-changed") {
      await this.handleProcessStateChanged(event);
      return;
    }

    if (event.type === "process-terminated") {
      await this.handleProcessTerminated(event);
    }
  }

  private async handleProcessStateChanged(
    event: ProcessStateEvent,
  ): Promise<void> {
    if (event.activity !== "idle") {
      return;
    }

    const process = await this.getProcess(event.sessionId);
    if (!process || this.getProcessActivity(process) !== "idle") {
      // Ignore the synthetic idle emitted during unregister; we only want
      // the live transition when the process is still resumable in-memory.
      return;
    }

    const payload = this.buildPayload({
      sessionId: event.sessionId,
      projectId: event.projectId,
      timestamp: event.timestamp,
      reason: "idle",
      process: {
        id: process.id,
        provider: process.provider,
        model: process.resolvedModel ?? process.model,
        executor: process.executor,
        permissionMode: process.permissionMode,
      },
      projectPath: process.projectPath,
      history: this.getMessageHistory(process),
    });

    await this.send(payload);
  }

  private async handleProcessTerminated(
    event: ProcessTerminatedEvent,
  ): Promise<void> {
    const process = await this.getProcess(event.sessionId);
    const projectPath =
      process?.projectPath ?? this.decodeProjectPath(event.projectId);
    if (!projectPath) {
      return;
    }

    const payload = this.buildPayload({
      sessionId: event.sessionId,
      projectId: event.projectId,
      timestamp: event.timestamp,
      reason: "error",
      summary: event.reason,
      process: {
        id: event.processId,
        provider: event.provider as ProviderName,
        model: process?.resolvedModel ?? process?.model,
        executor: process?.executor,
        permissionMode: process?.permissionMode,
      },
      projectPath,
      history: process ? this.getMessageHistory(process) : [],
    });

    await this.send(payload);
  }

  private buildPayload(input: {
    sessionId: string;
    projectId: UrlProjectId;
    timestamp: string;
    reason?: "idle" | "error";
    summary?: string;
    projectPath: string;
    process?: SessionInactiveWebhookPayload["process"];
    history: Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>;
  }): SessionInactiveWebhookPayload {
    const dryRun =
      this.options.serverSettingsService.getSetting("lifecycleWebhookDryRun") ??
      true;

    return {
      type: "session-inactive",
      timestamp: input.timestamp,
      session: {
        id: input.sessionId,
      },
      project: {
        id: input.projectId,
        path: input.projectPath,
        name: basename(input.projectPath),
      },
      process: input.process,
      reason: input.reason,
      summary: input.summary,
      lastUserMessageText: this.extractLastMessageText(input.history, "user"),
      lastMessageText: this.extractLastMessageText(input.history),
      dryRun,
    };
  }

  private async getProcess(
    sessionId: string,
  ): Promise<WebhookProcessView | null> {
    if (this.options.runtimeController) {
      return this.options.runtimeController.getProcessSnapshotForSession(
        sessionId,
      );
    }
    return (
      (this.options.supervisor?.getProcessForSession(sessionId) as
        | WebhookProcessView
        | undefined) ?? null
    );
  }

  private getProcessActivity(process: WebhookProcessView): string {
    return typeof process.state === "string"
      ? process.state
      : process.state.type;
  }

  private getMessageHistory(process: WebhookProcessView) {
    return process.messageHistory ?? process.getMessageHistory?.() ?? [];
  }

  private async send(payload: SessionInactiveWebhookPayload): Promise<void> {
    const settings = this.options.serverSettingsService.getSettings();
    if (!settings.lifecycleWebhooksEnabled) {
      return;
    }

    const webhookUrl = settings.lifecycleWebhookUrl?.trim();
    if (!webhookUrl) {
      return;
    }

    const headers = new Headers({
      "content-type": "application/json",
    });
    const token = settings.lifecycleWebhookToken?.trim();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(
          `[LifecycleWebhook] Request failed with status ${response.status}`,
        );
      }
    } catch (error) {
      console.error("[LifecycleWebhook] Request failed:", error);
    }
  }

  private decodeProjectPath(projectId: UrlProjectId): string | undefined {
    try {
      return decodeProjectId(projectId);
    } catch {
      return undefined;
    }
  }

  private extractLastMessageText(
    history: Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>,
    role?: "user" | "assistant",
  ): string | undefined {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (!entry) continue;

      const entryRole =
        entry.type === "user" || entry.type === "assistant"
          ? entry.type
          : entry.message?.role;
      if (role && entryRole !== role) {
        continue;
      }

      const content = entry.message?.content;
      const text = this.extractTextContent(content);
      if (text) {
        return text;
      }
    }

    return undefined;
  }

  private extractTextContent(content: unknown): string | undefined {
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return undefined;
    }

    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        return block.text.trim();
      }
    }

    return undefined;
  }
}
