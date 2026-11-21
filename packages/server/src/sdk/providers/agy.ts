/**
 * Antigravity CLI ACP provider (`agy acp`).
 *
 * Google's Antigravity CLI replaced Gemini CLI for personal Google accounts
 * (Free / Google AI Pro / Ultra). It ships a full ACP server: session/new,
 * session/load (history replay), session/resume, session/list,
 * session/close, session/cancel, `session/set_mode`
 * (default/accept-edits/auto/plan) and select config options for `model`
 * (family) and `thought_level` (low/medium/high/xhigh). Tool approvals use
 * `session/request_permission`; `ask_question` uses form elicitation.
 * Sending `session/prompt` during a running turn steers that turn.
 *
 * History is read from `~/.gemini/antigravity-cli` by AgySessionReader; this
 * provider only streams live turns.
 *
 * Protocol facts come from the installed CLI (references/antigravity/probe)
 * — agy is closed source, so never implement from memory.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  ClientCapabilities,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@yep-anywhere/shared";
import { AcpCommandTracker } from "../../agent-commands/acp-commands.js";
import { readAgentCommandCache } from "../../agent-commands/command-cache.js";
import { getLogger } from "../../logging/logger.js";
import {
  canonicalizeAgyToolName,
  cleanAgyToolOutput,
  inferAgyNativeToolName,
  normalizeAgyToolArguments,
} from "../../sessions/agy-tools.js";
import { whichCommand } from "../cli-detection.js";
import { MessageQueue, getUserPromptProjection } from "../messageQueue.js";
import type {
  PermissionMode,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import { ACPClient } from "./acp/client.js";
import {
  AGY_FALLBACK_MODELS,
  AGY_MODEL_CONFIG_ID,
  AGY_THOUGHT_CONFIG_ID,
  buildAgyModelCatalog,
  parseAgyModelsOutput,
  resolveAgyModelChoice,
} from "./agy-models.js";
import {
  buildAgyElicitationContent,
  planAgyQuestionnaire,
} from "./agy-questions.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

const execFileAsync = promisify(execFile);
const log = getLogger();

/**
 * Form elicitation lets `ask_question` reach Yep as a questionnaire instead
 * of being printed and ending the turn.
 */
const AGY_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
} as unknown as ClientCapabilities;

const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const AUTH_OK_TTL_MS = 5 * 60_000;
const AUTH_MISSING_TTL_MS = 20_000;
const MODELS_TIMEOUT_MS = 30_000;

/** ACP error code agy returns before the user signed in. */
const AUTH_REQUIRED_CODE = -32000;
export const AGY_AUTH_REQUIRED_MESSAGE =
  "Antigravity CLI is not signed in. Run `agy` once in a terminal on the Yep host (or `agy acp --login` over SSH) and complete the Google sign-in, then retry.";

export type AgyModeId = "default" | "accept-edits" | "auto" | "plan";

/**
 * Map Yep's permission mode onto agy's execution mode. `auto` is not
 * available everywhere (business accounts, no terminal sandbox); callers
 * pass the advertised modes so we can fall back instead of failing.
 * `bypassPermissions` uses the most permissive native mode and lets Yep's
 * bypass policy answer whatever agy still asks.
 */
export function toAgyMode(
  mode: PermissionMode,
  available: readonly string[] | undefined,
): AgyModeId {
  const has = (id: AgyModeId) => !available || available.includes(id);
  switch (mode) {
    case "acceptEdits":
      return "accept-edits";
    case "plan":
      return "plan";
    case "auto":
      return has("auto") ? "auto" : "default";
    case "bypassPermissions":
      return has("auto") ? "auto" : "accept-edits";
    default:
      return "default";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthRequiredError(error: unknown): boolean {
  if (isRecord(error)) {
    if (error.code === AUTH_REQUIRED_CODE) return true;
    if (
      typeof error.message === "string" &&
      /authentication required/i.test(error.message)
    ) {
      return true;
    }
  }
  return (
    error instanceof Error && /authentication required/i.test(error.message)
  );
}

function textFromContentList(list: unknown): string {
  if (!Array.isArray(list)) return "";
  const parts: string[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const inner = item.type === "content" ? item.content : item;
    if (
      isRecord(inner) &&
      inner.type === "text" &&
      typeof inner.text === "string" &&
      inner.text
    ) {
      parts.push(inner.text);
    }
  }
  return parts.join("\n");
}

/** Live tool result text; the persisted transcript replaces it later. */
export function agyToolResultText(update: {
  content?: unknown;
  rawOutput?: unknown;
}): string {
  const raw = update.rawOutput;
  if (typeof raw === "string") return cleanAgyToolOutput(raw);
  if (isRecord(raw)) {
    if (typeof raw.output === "string" && raw.output) {
      return cleanAgyToolOutput(raw.output);
    }
    if (typeof raw.error === "string") return raw.error;
    if (isRecord(raw.error) && typeof raw.error.message === "string") {
      return raw.error.message;
    }
  }
  return textFromContentList(update.content);
}

/**
 * agy adds a non-standard `name` (native tool name) next to `title`. The ACP
 * SDK drops it while validating, so the provider records it from raw frames
 * (`names`); an argument-shape inference covers anything it missed.
 */
function nativeToolName(
  update: unknown,
  names?: ReadonlyMap<string, string>,
): string {
  if (!isRecord(update)) return "tool";
  const recorded =
    typeof update.toolCallId === "string"
      ? names?.get(update.toolCallId)
      : undefined;
  if (recorded) return recorded;
  if (typeof update.name === "string" && update.name) return update.name;
  return inferAgyNativeToolName(update);
}

/** Remember agy's vendor tool names from raw ACP frames (see ACPClient). */
export function recordAgyToolNames(
  frame: Record<string, unknown>,
  names: Map<string, string>,
): void {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (!params) return;
  const candidate =
    frame.method === "session/update"
      ? params.update
      : frame.method === "session/request_permission"
        ? params.toolCall
        : undefined;
  if (
    isRecord(candidate) &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.name === "string" &&
    candidate.name
  ) {
    names.set(candidate.toolCallId, candidate.name);
  }
}

function toolInput(update: { rawInput?: unknown; locations?: unknown }): {
  raw: unknown;
} {
  const raw =
    update.rawInput ??
    (isRecord(update) && "args" in update
      ? (update as { args?: unknown }).args
      : undefined);
  return { raw };
}

function toolUseMessage(
  sessionId: string,
  id: string,
  nativeName: string,
  rawInput: unknown,
): SDKMessage {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: canonicalizeAgyToolName(nativeName, rawInput),
          input: normalizeAgyToolArguments(nativeName, rawInput),
        },
      ],
    },
  } as SDKMessage;
}

function toolResultMessage(
  sessionId: string,
  id: string,
  update: { content?: unknown; rawOutput?: unknown },
  failed: boolean,
): SDKMessage {
  return {
    type: "user",
    uuid: randomUUID(),
    session_id: sessionId,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: agyToolResultText(update),
          ...(failed ? { is_error: true } : {}),
        },
      ],
    },
  } as SDKMessage;
}

/**
 * Convert one non-text ACP update into SDK messages. `seen` remembers each
 * call's name and last input so in-flight status changes (pending approval
 * and back) do not re-emit an unchanged tool row.
 */
export function convertAgyUpdate(
  update: SessionUpdate,
  sessionId: string,
  seen: Map<string, { name: string; input: string }>,
  names?: ReadonlyMap<string, string>,
): SDKMessage[] {
  switch (update.sessionUpdate) {
    case "tool_call":
    case "tool_call_update": {
      const previous = seen.get(update.toolCallId);
      const name =
        update.sessionUpdate === "tool_call" || !previous
          ? nativeToolName(update, names)
          : previous.name;
      const { raw } = toolInput(update);
      const messages: SDKMessage[] = [];
      const inputKey = raw === undefined ? "" : JSON.stringify(raw);
      if (!previous || (raw !== undefined && inputKey !== previous.input)) {
        seen.set(update.toolCallId, { name, input: inputKey });
        messages.push(toolUseMessage(sessionId, update.toolCallId, name, raw));
      }
      if (update.status === "completed" || update.status === "failed") {
        messages.push(
          toolResultMessage(
            sessionId,
            update.toolCallId,
            update,
            update.status === "failed",
          ),
        );
      }
      return messages;
    }
    default:
      // usage_update / session_info_update / available_commands_update /
      // current_mode_update / config_option_update are status metadata; the
      // persisted transcript remains the durable source.
      return [];
  }
}

function textMessage(
  sessionId: string,
  id: string | null,
  text: string,
): SDKMessage {
  return {
    type: "assistant",
    uuid: id ?? undefined,
    session_id: sessionId,
    message: { role: "assistant", content: text },
  } as SDKMessage;
}

function thinkingMessage(
  sessionId: string,
  id: string | null,
  thinking: string,
): SDKMessage {
  return {
    type: "assistant",
    uuid: id ?? undefined,
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  } as SDKMessage;
}

export interface AgyProviderConfig {
  /** Explicit agy binary path (auto-detected when omitted). */
  agyPath?: string;
}

interface PromptTracker {
  promise: Promise<PromptResponse>;
  done: boolean;
}

interface AgySessionState {
  sessionId: string | null;
  permissionMode: PermissionMode;
  /** True while a turn is streaming; steering is only valid then. */
  promptActive: boolean;
  /**
   * The ACP prompt that owns the rest of the running turn. A steering
   * prompt replaces it: agy resolves the earlier request right away and
   * reports the turn's outcome on the newest one.
   */
  prompt: PromptTracker | null;
  /** Native tool names by ACP call id, recorded from raw frames. */
  toolNames: Map<string, string>;
  model?: string;
  reasoningEffort?: string;
}

function trackPrompt(promise: Promise<PromptResponse>): PromptTracker {
  const tracker: PromptTracker = { promise, done: false };
  promise.then(
    () => {
      tracker.done = true;
    },
    () => {
      tracker.done = true;
    },
  );
  return tracker;
}

function selectValues(
  configOptions: unknown,
  id: string,
): { current?: string; values: string[] } {
  if (!Array.isArray(configOptions)) return { values: [] };
  const option = configOptions.find(
    (candidate) => isRecord(candidate) && candidate.id === id,
  );
  if (!isRecord(option)) return { values: [] };
  const values: string[] = [];
  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      if (Array.isArray(entry.options)) collect(entry.options);
      else if (typeof entry.value === "string") values.push(entry.value);
    }
  };
  collect(option.options);
  return {
    current:
      typeof option.currentValue === "string" ? option.currentValue : undefined,
    values,
  };
}

export class AgyProvider implements AgentProvider {
  readonly name: ProviderName = "agy";
  readonly displayName = "Antigravity";
  readonly supportsPermissionMode = true;
  readonly permissionModes = [
    "default",
    "acceptEdits",
    "auto",
    "plan",
    "bypassPermissions",
  ] as const;
  // Thinking depth is the per-model reasoning effort (agy `thought_level`).
  readonly supportsThinkingToggle = false;
  // `/` built-ins and skills come from ACP `available_commands_update`.
  readonly supportsSlashCommands = true;

  private readonly agyPath?: string;
  private catalog?: {
    at: number;
    models: ModelInfo[];
    authenticated: boolean;
  };
  private catalogInFlight?: Promise<{
    models: ModelInfo[];
    authenticated: boolean;
  }>;

  constructor(config: AgyProviderConfig = {}) {
    this.agyPath = config.agyPath;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.findAgyPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAuthStatus()).authenticated;
  }

  /**
   * agy keeps its credentials in the OS keyring, which Yep never reads.
   * `agy models` is sign-in gated, so one probe yields both the auth state
   * and the model catalog.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    if (!(await this.isInstalled())) {
      return { installed: false, authenticated: false, enabled: false };
    }
    // Stale-while-revalidate: provider listings must not wait on `agy models`
    // (a network round trip) except the very first time.
    const { authenticated } = this.catalog
      ? this.cachedCatalogAndRefresh()
      : await this.loadCatalog();
    return { installed: true, authenticated, enabled: authenticated };
  }

  /**
   * Drop the cached sign-in state and probe `agy models` again. Used after a
   * Yep-driven sign-in or sign-out changed the keyring.
   */
  async refreshAuthStatus(): Promise<boolean> {
    this.catalog = undefined;
    if (this.catalogInFlight) await this.catalogInFlight.catch(() => undefined);
    this.catalog = undefined;
    return (await this.loadCatalog()).authenticated;
  }

  async getAvailableModels(options?: {
    waitForRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    if (options?.waitForRefresh === false && this.catalog) {
      return this.cachedCatalogAndRefresh().models;
    }
    return (await this.loadCatalog()).models;
  }

  private isCatalogFresh(catalog: { at: number; authenticated: boolean }) {
    const ttl = catalog.authenticated
      ? Math.min(MODEL_CATALOG_TTL_MS, AUTH_OK_TTL_MS)
      : AUTH_MISSING_TTL_MS;
    return Date.now() - catalog.at < ttl;
  }

  private cachedCatalogAndRefresh(): {
    models: ModelInfo[];
    authenticated: boolean;
  } {
    const cached = this.catalog;
    if (!cached) throw new Error("Antigravity catalog is not loaded");
    if (!this.isCatalogFresh(cached)) {
      void this.loadCatalog().catch(() => undefined);
    }
    return cached;
  }

  private loadCatalog(): Promise<{
    models: ModelInfo[];
    authenticated: boolean;
  }> {
    const cached = this.catalog;
    if (cached && this.isCatalogFresh(cached)) return Promise.resolve(cached);
    if (!this.catalogInFlight) {
      this.catalogInFlight = this.probeCatalog()
        .then((result) => {
          this.catalog = { ...result, at: Date.now() };
          return result;
        })
        .finally(() => {
          this.catalogInFlight = undefined;
        });
    }
    return this.catalogInFlight;
  }

  private async probeCatalog(): Promise<{
    models: ModelInfo[];
    authenticated: boolean;
  }> {
    const agyPath = await this.findAgyPath();
    if (!agyPath) return { models: AGY_FALLBACK_MODELS, authenticated: false };
    try {
      const { stdout } = await execFileAsync(agyPath, ["models"], {
        timeout: MODELS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...agySpawnEnv(agyPath) },
      });
      const models = buildAgyModelCatalog(parseAgyModelsOutput(stdout));
      if (models.length > 0) return { models, authenticated: true };
      return {
        models: this.catalog?.models ?? AGY_FALLBACK_MODELS,
        authenticated: false,
      };
    } catch (error) {
      const output = isRecord(error)
        ? `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`
        : "";
      const signedOut = /sign in/i.test(output);
      log.debug(
        { err: error, signedOut },
        "Antigravity `agy models` probe failed",
      );
      return {
        models: this.catalog?.models ?? AGY_FALLBACK_MODELS,
        // A transient network failure must not log a signed-in user out.
        authenticated: signedOut
          ? false
          : (this.catalog?.authenticated ?? false),
      };
    }
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue({ preserveAttachments: true });
    const abortController = new AbortController();
    const state: AgySessionState = {
      sessionId: null,
      permissionMode: options.permissionMode ?? "default",
      promptActive: false,
      prompt: null,
      toolNames: new Map(),
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    };
    if (options.initialMessage) queue.push(options.initialMessage);

    const client = new ACPClient();
    const commands = new AcpCommandTracker("agy", options.cwd);
    const iterator = this.runSession(
      client,
      options,
      queue,
      state,
      abortController.signal,
      commands,
    );

    const requireSession = (): string => {
      if (!state.sessionId) {
        throw new Error("Antigravity ACP session is not initialized yet");
      }
      return state.sessionId;
    };

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        queue.close();
        if (state.sessionId) {
          void client.cancel(state.sessionId).catch(() => undefined);
        }
        client.close();
      },
      isProcessAlive: () => client.isAlive(),
      get pid() {
        return client.pid;
      },
      interrupt: async () => {
        if (state.sessionId) await client.cancel(state.sessionId);
      },
      steer: async (message: UserMessage) => {
        if (!state.sessionId || !state.promptActive || !state.prompt) {
          return false;
        }
        const { internalPrompt } = getUserPromptProjection(message);
        const blocks = await this.buildPromptBlocks(message, internalPrompt);
        // Re-check: the turn may have ended while attachments were read.
        if (!state.promptActive) return false;
        state.prompt = trackPrompt(client.prompt(state.sessionId, blocks));
        return { accepted: true };
      },
      setPermissionMode: async (mode) => {
        const sessionId = requireSession();
        await this.applyPermissionMode(client, sessionId, mode);
        state.permissionMode = mode;
      },
      setModel: async (model?: string) => {
        if (!model) return;
        const sessionId = requireSession();
        await this.applyModel(client, sessionId, model, state.reasoningEffort);
        state.model = model;
      },
      setReasoningEffort: async (effort: string) => {
        const sessionId = requireSession();
        const model =
          state.model ??
          selectValues(
            client.getSessionConfigOptions(sessionId),
            AGY_MODEL_CONFIG_ID,
          ).current;
        if (!model) throw new Error("Antigravity model is not known yet");
        await this.applyModel(client, sessionId, model, effort);
        state.reasoningEffort = effort;
      },
      supportedModels: () => this.getAvailableModels(),
      supportedCommands: async () =>
        (await commands.current()) ??
        (await readAgentCommandCache("agy", options.cwd)) ??
        [],
    };
  }

  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    state: AgySessionState,
    signal: AbortSignal,
    commands?: AcpCommandTracker,
  ): AsyncIterableIterator<SDKMessage> {
    const agyPath = await this.findAgyPath();
    if (!agyPath) {
      yield {
        type: "error",
        error:
          "Antigravity CLI (agy) not found. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once to sign in.",
      } as SDKMessage;
      return;
    }

    const updateQueue: SessionNotification[] = [];
    client.setSessionUpdateCallback((update) => {
      // The `/` list arrives right after session/new or resume; it is
      // metadata, not a transcript row.
      if (commands?.accept(update)) return;
      updateQueue.push(update);
    });
    client.setPermissionRequestCallback((request) =>
      this.handlePermissionRequest(request, options, signal, state),
    );
    client.setElicitationRequestCallback((request) =>
      this.handleElicitation(request, options, signal),
    );
    client.setExtensionRequestCallback(async () => ({}));
    client.setRawMessageObserver((frame) =>
      recordAgyToolNames(frame, state.toolNames),
    );

    try {
      await client.connect({
        command: agyPath,
        args: ["acp"],
        cwd: options.cwd,
        env: agySpawnEnv(agyPath),
      });
      await client.initialize(AGY_CLIENT_CAPABILITIES);

      let sessionId: string;
      if (options.resumeSessionId) {
        sessionId = await this.attachSession(
          client,
          options.resumeSessionId,
          options.cwd,
        );
        // Disk history is the transcript source; never re-stream a replay.
        updateQueue.length = 0;
      } else {
        sessionId = await client.newSession(options.cwd);
      }
      state.sessionId = sessionId;

      // agy does not restore a conversation's previous model, tier or mode
      // on resume/load; always re-apply Yep's selection.
      await this.applyPermissionMode(client, sessionId, state.permissionMode);
      const model =
        options.model ??
        selectValues(
          client.getSessionConfigOptions(sessionId),
          AGY_MODEL_CONFIG_ID,
        ).current;
      if (model && (options.model || options.reasoningEffort)) {
        await this.applyModel(
          client,
          sessionId,
          model,
          options.reasoningEffort,
        );
      }
      const configOptions = client.getSessionConfigOptions(sessionId);
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
        model:
          selectValues(configOptions, AGY_MODEL_CONFIG_ID).current ??
          options.model,
        reasoningEffort:
          selectValues(configOptions, AGY_THOUGHT_CONFIG_ID).current ??
          options.reasoningEffort,
      } as SDKMessage;

      for await (const message of queue.generator()) {
        if (signal.aborted) break;
        const { internalPrompt, publicPrompt } =
          getUserPromptProjection(message);
        const userUuid = (message as { uuid?: string }).uuid ?? randomUUID();
        yield {
          type: "user",
          uuid: userUuid,
          session_id: sessionId,
          message: { role: "user", content: publicPrompt },
        } as SDKMessage;

        updateQueue.length = 0;
        const blocks = await this.buildPromptBlocks(message, internalPrompt);
        state.prompt = trackPrompt(client.prompt(sessionId, blocks));
        state.promptActive = true;
        try {
          yield* this.streamTurn(sessionId, updateQueue, signal, state);
        } finally {
          state.promptActive = false;
          state.prompt = null;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      const authRequired = isAuthRequiredError(error);
      log.error({ err: error, authRequired }, "Antigravity ACP session failed");
      yield {
        type: "error",
        error: authRequired
          ? AGY_AUTH_REQUIRED_MESSAGE
          : error instanceof Error
            ? error.message
            : isRecord(error) && typeof error.message === "string"
              ? error.message
              : String(error),
        ...(authRequired ? { errorCode: "agy.auth_required" } : {}),
      } as SDKMessage;
    } finally {
      queue.close();
      client.close();
    }
  }

  /**
   * Attach to an existing conversation (takeover). `session/resume`
   * attaches without replay; `session/load` is the fallback. Never start a
   * new conversation instead: taking over must continue the same one or
   * fail visibly.
   */
  private async attachSession(
    client: ACPClient,
    sessionId: string,
    cwd: string,
  ): Promise<string> {
    try {
      return await client.resumeSession(sessionId, cwd);
    } catch (resumeError) {
      if (isAuthRequiredError(resumeError)) throw resumeError;
      log.warn(
        { err: resumeError, sessionId },
        "Antigravity session/resume failed; trying session/load",
      );
      await client.loadSession(sessionId, cwd);
      return sessionId;
    }
  }

  private async applyPermissionMode(
    client: ACPClient,
    sessionId: string,
    mode: PermissionMode,
  ): Promise<void> {
    const modes = client.getSessionModes(sessionId);
    const available = modes?.availableModes.map((entry) => entry.id);
    const target = toAgyMode(mode, available);
    if (mode === "auto" && target !== "auto") {
      log.info(
        { sessionId },
        "Antigravity auto mode is unavailable for this account; using default",
      );
    }
    if (modes?.currentModeId === target) return;
    await client.setSessionMode(sessionId, target);
    if (modes) modes.currentModeId = target;
  }

  private async applyModel(
    client: ACPClient,
    sessionId: string,
    model: string,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    const models = selectValues(
      client.getSessionConfigOptions(sessionId),
      AGY_MODEL_CONFIG_ID,
    );
    const choice = resolveAgyModelChoice(models.values, model, reasoningEffort);
    if (!choice) {
      throw new Error(`Antigravity does not offer model "${model}"`);
    }
    if (models.current !== choice.family) {
      const result = await client.setSessionConfigOption(
        sessionId,
        AGY_MODEL_CONFIG_ID,
        choice.family,
      );
      const applied = selectValues(
        result.configOptions,
        AGY_MODEL_CONFIG_ID,
      ).current;
      if (applied !== choice.family) {
        throw new Error(
          `Antigravity did not apply model "${model}" (active: "${applied ?? "unknown"}")`,
        );
      }
    }
    if (!choice.tier) return;
    const tiers = selectValues(
      client.getSessionConfigOptions(sessionId),
      AGY_THOUGHT_CONFIG_ID,
    );
    if (tiers.current === choice.tier) return;
    if (!tiers.values.includes(choice.tier)) {
      // Families differ in tiers (Flash has no `xhigh`); keep agy's default
      // rather than failing the turn.
      log.info(
        { sessionId, model: choice.family, tier: choice.tier },
        "Antigravity model does not offer the requested thinking level",
      );
      return;
    }
    await client.setSessionConfigOption(
      sessionId,
      AGY_THOUGHT_CONFIG_ID,
      choice.tier,
    );
  }

  /**
   * Stream one turn. The owning prompt can change mid-turn (steering); the
   * turn ends when the newest prompt has resolved and its updates drained.
   */
  private async *streamTurn(
    sessionId: string,
    updateQueue: SessionNotification[],
    signal: AbortSignal,
    state: AgySessionState,
  ): AsyncIterableIterator<SDKMessage> {
    const seen = new Map<string, { name: string; input: string }>();
    let text = "";
    let textId: string | null = null;
    let textDirty = false;
    let thinking = "";
    let thinkingId: string | null = null;
    let thinkingDirty = false;

    const flushThinking = function* (): Generator<SDKMessage> {
      if (thinking && thinkingDirty) {
        yield thinkingMessage(sessionId, thinkingId, thinking);
      }
      thinking = "";
      thinkingId = null;
      thinkingDirty = false;
    };
    const flushText = function* (): Generator<SDKMessage> {
      if (text && textDirty) yield textMessage(sessionId, textId, text);
      text = "";
      textId = null;
      textDirty = false;
    };

    let owner = state.prompt;
    while (!signal.aborted) {
      owner = state.prompt;
      if (owner?.done && updateQueue.length === 0) {
        // Stop admitting steers before any await: a later prompt must start
        // a new turn instead of attaching to one that is finishing.
        state.promptActive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      while (updateQueue.length > 0) {
        const notification = updateQueue.shift();
        if (!notification || notification.sessionId !== sessionId) continue;
        const update = notification.update;
        if (
          update.sessionUpdate === "agent_thought_chunk" &&
          update.content.type === "text"
        ) {
          yield* flushText();
          thinking += update.content.text;
          thinkingId ??= randomUUID();
          thinkingDirty = true;
          continue;
        }
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text"
        ) {
          yield* flushThinking();
          text += update.content.text;
          textId ??= randomUUID();
          textDirty = true;
          continue;
        }
        const converted = convertAgyUpdate(
          update,
          sessionId,
          seen,
          state.toolNames,
        );
        if (converted.length > 0) {
          yield* flushThinking();
          yield* flushText();
          yield* converted;
        }
      }
      if (thinkingDirty && thinking) {
        yield thinkingMessage(sessionId, thinkingId, thinking);
        thinkingDirty = false;
      }
      if (textDirty && text) {
        yield textMessage(sessionId, textId, text);
        textDirty = false;
      }
    }
    if (thinkingDirty && thinking) {
      yield thinkingMessage(sessionId, thinkingId, thinking);
    }
    if (textDirty && text) yield textMessage(sessionId, textId, text);
    if (!owner) return;

    try {
      const result = await owner.promise;
      if (result.stopReason === "refusal") {
        yield {
          type: "error",
          session_id: sessionId,
          error:
            "Antigravity did not complete the turn: the request was refused.",
          errorCode: "agy.acp.refusal",
        } as SDKMessage;
      }
      if (!signal.aborted) {
        yield {
          type: "result",
          session_id: sessionId,
          turnStatus:
            result.stopReason === "cancelled"
              ? "interrupted"
              : result.stopReason === "refusal"
                ? "failed"
                : "completed",
          ...(result.stopReason === "refusal" ? { is_error: true } : {}),
        } as SDKMessage;
      }
    } catch (error) {
      if (signal.aborted) return;
      yield {
        type: "error",
        session_id: sessionId,
        error: isAuthRequiredError(error)
          ? AGY_AUTH_REQUIRED_MESSAGE
          : error instanceof Error
            ? error.message
            : isRecord(error) && typeof error.message === "string"
              ? error.message
              : String(error),
      } as SDKMessage;
      yield {
        type: "result",
        session_id: sessionId,
        turnStatus: "failed",
        is_error: true,
      } as SDKMessage;
    }
  }

  /**
   * Route agy tool approvals through Yep. agy already applied its own mode
   * and permission rules before asking, so Yep only re-applies its policy
   * for bypassPermissions (agy has no per-session "skip everything" mode).
   */
  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
    state: AgySessionState,
  ): Promise<RequestPermissionResponse> {
    if (!options.onToolApproval) return { outcome: { outcome: "cancelled" } };
    const toolCall = request.toolCall;
    const nativeName = nativeToolName(toolCall, state.toolNames);
    const { raw } = toolInput(toolCall);
    const toolName = canonicalizeAgyToolName(nativeName, raw);
    const input = {
      ...normalizeAgyToolArguments(nativeName, raw),
      ...(toolCall.locations ? { locations: toolCall.locations } : {}),
    };
    const result = await options.onToolApproval(toolName, input, {
      signal,
      respectProviderDecision: state.permissionMode !== "bypassPermissions",
    });
    return convertApproval(result, request);
  }

  /** `ask_question` through ACP form elicitation. */
  private async handleElicitation(
    request: CreateElicitationRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    if (!options.onToolApproval || request.mode !== "form") {
      return { action: "decline" };
    }
    const plan = planAgyQuestionnaire(
      (request as { requestedSchema?: unknown }).requestedSchema,
      request.message,
    );
    if (!plan) {
      log.warn("Antigravity question schema was not understood");
      return { action: "decline" };
    }
    const result = await options.onToolApproval(
      "AskUserQuestion",
      { questions: plan.questions },
      { signal, respectProviderDecision: true },
    );
    if (result.behavior !== "allow") return { action: "decline" };
    const answers = isRecord(result.updatedInput)
      ? result.updatedInput.answers
      : undefined;
    if (!isRecord(answers)) return { action: "cancel" };
    return {
      action: "accept",
      content: buildAgyElicitationContent(plan, answers),
    } as CreateElicitationResponse;
  }

  private async buildPromptBlocks(
    message: unknown,
    text: string,
  ): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [{ type: "text", text }];
    if (!isRecord(message)) return blocks;
    const seen = new Set<string>();
    const content = isRecord(message.message)
      ? message.message.content
      : undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "image") continue;
        const source = isRecord(block.source) ? block.source : undefined;
        if (source?.type !== "base64" || typeof source.data !== "string") {
          continue;
        }
        seen.add(source.data);
        blocks.push({
          type: "image",
          mimeType:
            typeof source.media_type === "string"
              ? source.media_type
              : "image/png",
          data: source.data,
        });
      }
    }
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : [];
    for (const attachment of attachments) {
      if (!isRecord(attachment) || typeof attachment.path !== "string") {
        continue;
      }
      const path = attachment.path;
      const mimeType =
        typeof attachment.mimeType === "string" ? attachment.mimeType : "";
      if (mimeType.startsWith("image/")) {
        try {
          const data = (await readFile(path)).toString("base64");
          if (!seen.has(data)) {
            seen.add(data);
            blocks.push({ type: "image", mimeType, data });
          }
          continue;
        } catch {
          // Fall through: the path still reaches agy as a resource link.
        }
      }
      blocks.push({
        type: "resource_link",
        uri: pathToFileURL(path).href,
        name:
          (typeof attachment.originalName === "string"
            ? attachment.originalName
            : undefined) ?? basename(path),
        ...(mimeType ? { mimeType } : {}),
      });
    }
    return blocks;
  }

  private async findAgyPath(): Promise<string | null> {
    return findAgyPath(this.agyPath);
  }
}

function convertApproval(
  result: ToolApprovalResult,
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  if (result.behavior === "allow") {
    const allow =
      request.options.find((option) => option.kind === "allow_once") ??
      request.options.find((option) => option.kind === "allow_always");
    return allow
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  const reject = request.options.find(
    (option) =>
      option.kind === "reject_once" || option.kind === "reject_always",
  );
  return reject
    ? { outcome: { outcome: "selected", optionId: reject.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/**
 * agy is a static binary, but services launched by launchd do not inherit
 * the shell PATH that holds `~/.local/bin`; agy's own subprocesses (git,
 * shell commands) need a sensible PATH.
 */
export function agySpawnEnv(agyPath: string): Record<string, string> {
  const binDir = dirname(agyPath);
  const current = process.env.PATH ?? "";
  const parts = current.split(delimiter);
  return {
    PATH: parts.includes(binDir)
      ? current
      : current
        ? `${binDir}${delimiter}${current}`
        : binDir,
  };
}

let cachedAgyPath: { at: number; path: string | null } | null = null;

export async function findAgyPath(explicit?: string): Promise<string | null> {
  const candidates = [explicit, process.env.AGY_PATH?.trim()].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  if (cachedAgyPath && Date.now() - cachedAgyPath.at < 60_000) {
    return cachedAgyPath.path;
  }
  const remember = (path: string | null) => {
    cachedAgyPath = { at: Date.now(), path };
    return path;
  };
  const home = homedir();
  const common = [
    join(home, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  for (const path of common) {
    if (existsSync(path)) return remember(path);
  }
  try {
    const [command, ...args] = whichCommand("agy").split(" ");
    if (command) {
      const { stdout } = await execFileAsync(command, args, {
        encoding: "utf-8",
      });
      const result = stdout.trim().split("\n")[0]?.trim();
      if (result && existsSync(result)) return remember(result);
    }
  } catch {
    // Not on PATH (typical for launchd services).
  }
  return remember(null);
}

export const agyProvider = new AgyProvider();
