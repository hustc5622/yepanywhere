/**
 * MiniMax Code ACP provider (`mcode acp`).
 *
 * MiniMax Code ships a full ACP server: session/new, session/load (history
 * replay), session/resume, session/list, session/fork, session/close,
 * session/cancel, `set_mode` (default/plan) and select config options for
 * `permissionMode` (default/auto/bypassPermissions), `model` and
 * `thinkingEffort`. It also exposes `mcode/session/steer` for in-turn
 * steering and asks structured questions through `elicitation/create`.
 *
 * The CLI and the MiniMax Code desktop App share `~/.minimax`, so a session
 * created in the App can be resumed (taken over) here by id. History is read
 * from disk by McodeSessionReader; this provider only streams live turns.
 *
 * Protocol facts come from the installed CLI and
 * references/minimax/pretty/run-acp-command.js — not from memory.
 */

import { exec } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
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
  MCODE_DATA_DIR,
  findMcodeSessionRecord,
  getMcodeTranscriptStats,
  listMcodeSessionRecords,
  summarizeMcodeQuestionnaireResponse,
} from "../../sessions/mcode-store.js";
import {
  canonicalizeMcodeToolName,
  normalizeMcodeToolArguments,
} from "../../sessions/mcode-tools.js";
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
  MCODE_EFFORT_CONFIG_ID,
  MCODE_FALLBACK_MODELS,
  MCODE_MODEL_CONFIG_ID,
  MCODE_PERMISSION_CONFIG_ID,
  MCODE_REASONING_OFF,
  buildMcodeModelCatalog,
  getMcodeSelectOptions,
  resolveMcodeModelValue,
} from "./mcode-models.js";
import {
  buildMcodeElicitationContent,
  planMcodeQuestionnaire,
} from "./mcode-questions.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

const execAsync = promisify(exec);
const log = getLogger();

/** Advertise form elicitation so mcode sends full multi-step questionnaires. */
const MCODE_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
} as unknown as ClientCapabilities;

const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const MODEL_PROBE_TIMEOUT_MS = 20_000;

async function modelConfigRevision(): Promise<string> {
  try {
    // mcode may atomically rewrite identical config on startup. File metadata
    // would invalidate every successful probe; retain only a content digest.
    const content = await readFile(join(MCODE_DATA_DIR, "config.yaml"));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "unavailable";
  }
}

export type McodePermissionValue = "default" | "auto" | "bypassPermissions";

/** Map Yep's shared permission mode onto mcode's process permission policy. */
export function toMcodePermission(mode: PermissionMode): McodePermissionValue {
  switch (mode) {
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/** Plan is a session mode in mcode, orthogonal to the permission policy. */
export function toMcodeSessionMode(mode: PermissionMode): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContentList(list: unknown): string {
  if (!Array.isArray(list)) return "";
  const parts: string[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    // ACP ToolCallContent: {type:"content", content:{type:"text", text}}
    const inner = item.type === "content" ? item.content : item;
    if (
      isRecord(inner) &&
      inner.type === "text" &&
      typeof inner.text === "string"
    ) {
      parts.push(inner.text);
    }
  }
  return parts.join("\n");
}

function toolResultText(update: {
  content?: unknown;
  rawOutput?: unknown;
}): string {
  // rawOutput is mcode's native tool result (what messages.jsonl persists);
  // ACP `content` is a display projection (e.g. the written file body).
  const raw = update.rawOutput;
  if (typeof raw === "string") return raw;
  if (isRecord(raw)) {
    const fromRaw = textFromContentList(raw.content);
    if (fromRaw) return fromRaw;
    if (typeof raw.error === "string") return raw.error;
    if (isRecord(raw.error) && typeof raw.error.message === "string") {
      return raw.error.message;
    }
  }
  const fromContent = textFromContentList(update.content);
  if (fromContent) return fromContent;
  if (raw === undefined || raw === null) return "";
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
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
          name: canonicalizeMcodeToolName(nativeName),
          input: normalizeMcodeToolArguments(nativeName, rawInput),
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
          content: toolResultText(update),
          ...(failed ? { is_error: true } : {}),
        },
      ],
    },
  } as SDKMessage;
}

/**
 * Convert one non-text ACP update. Text/thought chunks are buffered by the
 * caller so streaming deltas collapse into one row.
 */
export function convertMcodeUpdate(
  update: SessionUpdate,
  sessionId: string,
  toolNames: Map<string, string>,
): SDKMessage[] {
  switch (update.sessionUpdate) {
    case "tool_call": {
      // mcode sets `title` to the native tool name (projectTool in the ACP
      // server); `kind` is only a coarse category.
      const name = update.title?.trim() || "tool";
      toolNames.set(update.toolCallId, name);
      const messages = [
        toolUseMessage(sessionId, update.toolCallId, name, update.rawInput),
      ];
      // Replayed / fast tools arrive already terminal with their output.
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
    case "tool_call_update": {
      const name =
        toolNames.get(update.toolCallId) ?? update.title?.trim() ?? "tool";
      if (update.status === "completed" || update.status === "failed") {
        return [
          toolResultMessage(
            sessionId,
            update.toolCallId,
            update,
            update.status === "failed",
          ),
        ];
      }
      // Richer arguments for an in-flight call: re-emit the same tool id;
      // client preprocessing deduplicates tool_use blocks by id.
      if (isRecord(update.rawInput)) {
        return [
          toolUseMessage(sessionId, update.toolCallId, name, update.rawInput),
        ];
      }
      return [];
    }
    default:
      // plan / usage_update / available_commands_update / current_mode_update
      // / config_option_update are status metadata, not transcript rows. The
      // persisted messages.jsonl remains the durable source.
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

export interface McodeProviderConfig {
  /** Explicit mcode binary path (auto-detected when omitted). */
  mcodePath?: string;
}

interface McodeSessionState {
  sessionId: string | null;
  permissionMode: PermissionMode;
  /** True while an ACP `session/prompt` is in flight (steer is allowed). */
  promptActive: boolean;
  /**
   * Set when the user answers an mcode questionnaire during the active
   * prompt. mcode then continues in a background turn after the prompt
   * returns, so the turn is only complete once that continuation persists.
   */
  questionnaireAnsweredAt?: number;
  model?: string;
  reasoningEffort?: string;
}

export class McodeProvider implements AgentProvider {
  readonly name: ProviderName = "mcode";
  readonly displayName = "MiniMax Code";
  readonly supportsPermissionMode = true;
  readonly permissionModes = [
    "default",
    "plan",
    "auto",
    "bypassPermissions",
  ] as const;
  // Thinking depth is exposed per model through supportedReasoningEfforts.
  readonly supportsThinkingToggle = false;
  // `/` built-ins and skills come from ACP `available_commands_update`.
  readonly supportsSlashCommands = true;

  private readonly mcodePath?: string;
  private modelCatalogCache?: {
    at: number;
    revision: string;
    models: ModelInfo[];
  };
  private modelProbeInFlight?: {
    revision: string;
    promise: Promise<ModelInfo[]>;
  };

  constructor(config: McodeProviderConfig = {}) {
    this.mcodePath = config.mcodePath;
  }

  async isInstalled(): Promise<boolean> {
    return (await this.findMcodePath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAuthStatus()).authenticated;
  }

  /**
   * mcode stores OAuth credentials under `<dataDir>/auth` (shared with the
   * desktop App) or uses configured provider API keys in config.yaml. Treat
   * either as signed in; ACP reports a hard auth failure on prompt otherwise.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    if (!(await this.isInstalled())) {
      return { installed: false, authenticated: false, enabled: false };
    }
    let authenticated = false;
    try {
      authenticated = readdirSync(join(MCODE_DATA_DIR, "auth")).length > 0;
    } catch {
      authenticated = false;
    }
    if (!authenticated) {
      try {
        const config = await readFile(
          join(MCODE_DATA_DIR, "config.yaml"),
          "utf8",
        );
        authenticated = /custom_provider|api_?key/i.test(config);
      } catch {
        authenticated = false;
      }
    }
    return { installed: true, authenticated, enabled: authenticated };
  }

  /**
   * Models come from mcode's ACP `model` config option. Listing never creates
   * a MiniMax session (ACP has no session/delete): the catalog is refreshed
   * by a fresh CLI process resuming then closing idle sessions, which leaves
   * their history and timestamps untouched. A live process may retain an old
   * config snapshot, so its updates must not overwrite this global catalog.
   */
  async getAvailableModels(options?: {
    waitForRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    const revision = await modelConfigRevision();
    const cached =
      this.modelCatalogCache?.revision === revision
        ? this.modelCatalogCache
        : undefined;
    if (cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) {
      return cached.models;
    }
    if (this.modelProbeInFlight?.revision !== revision) {
      const flight = {
        revision,
        promise: Promise.resolve([] as ModelInfo[]),
      };
      this.modelProbeInFlight = flight;
      flight.promise = this.probeModelCatalog()
        .then(async (models) => {
          // A config edit during the probe must not bless an obsolete catalog.
          if ((await modelConfigRevision()) !== revision) {
            return MCODE_FALLBACK_MODELS;
          }
          if (models.length > 0 && this.modelProbeInFlight === flight) {
            this.modelCatalogCache = { at: Date.now(), revision, models };
          }
          return models.length > 0
            ? models
            : (cached?.models ?? MCODE_FALLBACK_MODELS);
        })
        .finally(() => {
          if (this.modelProbeInFlight === flight) {
            this.modelProbeInFlight = undefined;
          }
        });
    }
    const probe = this.modelProbeInFlight.promise;
    if (options?.waitForRefresh === false) {
      void probe.catch(() => undefined);
      return cached?.models ?? MCODE_FALLBACK_MODELS;
    }
    return probe;
  }

  private async probeModelCatalog(): Promise<ModelInfo[]> {
    const mcodePath = await this.findMcodePath();
    if (!mcodePath) return [];
    const records = await listMcodeSessionRecords();
    const targets = records.filter(
      (record) => record.status !== "started" && existsSync(record.cwd),
    );
    const first = targets[0];
    if (!first) return [];
    const client = new ACPClient();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      client.close();
    }, MODEL_PROBE_TIMEOUT_MS);
    try {
      await client.connect({
        command: mcodePath,
        args: ["acp"],
        cwd: first.cwd,
        env: mcodeSpawnEnv(mcodePath),
      });
      await client.initialize({});
      for (const target of targets) {
        if (timedOut) break;
        let attached = false;
        try {
          await client.resumeSession(target.sessionId, target.cwd);
          attached = true;
          const models = buildMcodeModelCatalog(
            client.getSessionConfigOptions(target.sessionId),
          );
          // mcode 0.6.12 omits the entire model option if the session's
          // saved model/variant is no longer in its catalog (ACP px/eh).
          // Try another idle session instead of keeping stale models forever.
          if (models.length > 0) return models;
        } catch (error) {
          log.debug({ err: error }, "MiniMax Code catalog session unavailable");
        } finally {
          if (attached && !timedOut) {
            await client
              .requestExtension("session/close", {
                sessionId: target.sessionId,
              })
              .catch(() => undefined);
          }
        }
      }
    } catch (error) {
      log.debug({ err: error }, "MiniMax Code model catalog probe failed");
    } finally {
      clearTimeout(timeout);
      client.close();
    }
    return [];
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue({ preserveAttachments: true });
    const abortController = new AbortController();
    const state: McodeSessionState = {
      sessionId: null,
      permissionMode: options.permissionMode ?? "default",
      promptActive: false,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    };
    if (options.initialMessage) queue.push(options.initialMessage);

    const client = new ACPClient();
    const commands = new AcpCommandTracker("mcode", options.cwd);
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
        throw new Error("MiniMax Code ACP session is not initialized yet");
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
        if (!state.sessionId || !state.promptActive) return false;
        const { internalPrompt } = getUserPromptProjection(message);
        try {
          const result = (await client.requestExtension("mcode/session/steer", {
            sessionId: state.sessionId,
            text: internalPrompt,
            clientRequestId:
              (message as { uuid?: string }).uuid ?? randomUUID(),
          })) as { turnId?: unknown } | undefined;
          return {
            accepted: true,
            ...(typeof result?.turnId === "string"
              ? { turnId: result.turnId }
              : {}),
          };
        } catch (error) {
          log.debug(
            { err: error, sessionId: state.sessionId },
            "MiniMax Code steer was not admitted",
          );
          return false;
        }
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
        const model = state.model ?? currentModelRef(client, sessionId);
        if (!model) throw new Error("MiniMax Code model is not known yet");
        await this.applyModel(client, sessionId, model, effort);
        state.reasoningEffort = effort;
      },
      supportedModels: () => this.getAvailableModels(),
      supportedCommands: async () =>
        (await commands.current()) ??
        (await readAgentCommandCache("mcode", options.cwd)) ??
        [],
    };
  }

  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    state: McodeSessionState,
    signal: AbortSignal,
    commands?: AcpCommandTracker,
  ): AsyncIterableIterator<SDKMessage> {
    const mcodePath = await this.findMcodePath();
    if (!mcodePath) {
      yield {
        type: "error",
        error:
          "MiniMax Code CLI (mcode) not found. Install @minimax/code and run `mcode login`.",
      } as SDKMessage;
      return;
    }

    const updateQueue: SessionNotification[] = [];
    const toolNames = new Map<string, string>();
    client.setSessionUpdateCallback((update) => {
      // The `/` list (built-ins plus skills) arrives right after
      // session/new or resume; it is metadata, not a transcript row.
      if (commands?.accept(update)) return;
      updateQueue.push(update);
    });
    client.setPermissionRequestCallback((request) =>
      this.handlePermissionRequest(request, options, signal),
    );
    client.setElicitationRequestCallback((request) =>
      this.handleElicitation(request, options, signal, state),
    );
    // mcode extension notifications (queue/goal/delegation updates) are
    // advisory; accept them so the SDK does not answer method-not-found.
    client.setExtensionRequestCallback(async () => ({}));

    try {
      await client.connect({
        command: mcodePath,
        args: ["acp"],
        cwd: options.cwd,
        env: mcodeSpawnEnv(mcodePath),
      });
      await client.initialize(MCODE_CLIENT_CAPABILITIES);

      let sessionId: string;
      if (options.resumeSessionId) {
        sessionId = await this.attachSession(
          client,
          options.resumeSessionId,
          options.cwd,
        );
        // session/load replays history as updates; disk history is the
        // transcript source, so never re-stream it.
        updateQueue.length = 0;
      } else {
        sessionId = await client.newSession(options.cwd);
      }
      state.sessionId = sessionId;

      await this.applyPermissionMode(client, sessionId, state.permissionMode);
      if (options.model) {
        await this.applyModel(
          client,
          sessionId,
          options.model,
          options.reasoningEffort,
        );
      } else if (options.reasoningEffort) {
        const model = currentModelRef(client, sessionId);
        if (model) {
          await this.applyModel(
            client,
            sessionId,
            model,
            options.reasoningEffort,
          );
        }
      }
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
        model: options.model ?? currentModelRef(client, sessionId),
        reasoningEffort: options.reasoningEffort,
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
        state.promptActive = true;
        try {
          yield* this.streamPrompt(
            client,
            sessionId,
            blocks,
            updateQueue,
            toolNames,
            signal,
            state,
          );
        } finally {
          state.promptActive = false;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      log.error({ err: error }, "MiniMax Code ACP session failed");
      yield {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      } as SDKMessage;
    } finally {
      queue.close();
      client.close();
    }
  }

  /**
   * Attach to an existing session (takeover). `session/resume` attaches
   * without replay; `session/load` is the fallback for agents/versions that
   * only accept load. Never silently start a new session instead: taking
   * over must continue the same MiniMax conversation or fail visibly.
   */
  private async attachSession(
    client: ACPClient,
    sessionId: string,
    cwd: string,
  ): Promise<string> {
    try {
      return await client.resumeSession(sessionId, cwd);
    } catch (resumeError) {
      log.warn(
        { err: resumeError, sessionId },
        "MiniMax Code session/resume failed; trying session/load",
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
    const permission = toMcodePermission(mode);
    const current = getMcodeSelectOptions(
      client.getSessionConfigOptions(sessionId) as never,
      MCODE_PERMISSION_CONFIG_ID,
    ).current;
    if (current !== permission) {
      await client.setSessionConfigOption(
        sessionId,
        MCODE_PERMISSION_CONFIG_ID,
        permission,
      );
    }
    await client.setSessionMode(sessionId, toMcodeSessionMode(mode));
  }

  private async applyModel(
    client: ACPClient,
    sessionId: string,
    model: string,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    const configOptions = client.getSessionConfigOptions(sessionId) as never;
    const value = resolveMcodeModelValue(configOptions, model, reasoningEffort);
    if (!value) {
      throw new Error(`MiniMax Code does not offer model "${model}"`);
    }
    const currentModel = getMcodeSelectOptions(
      configOptions,
      MCODE_MODEL_CONFIG_ID,
    ).current;
    if (currentModel !== value) {
      const result = await client.setSessionConfigOption(
        sessionId,
        MCODE_MODEL_CONFIG_ID,
        value,
      );
      const applied = getMcodeSelectOptions(
        result.configOptions as never,
        MCODE_MODEL_CONFIG_ID,
      ).current;
      if (applied !== value) {
        throw new Error(
          `MiniMax Code did not apply model "${model}" (active: "${applied ?? "unknown"}")`,
        );
      }
    }
    if (
      !reasoningEffort ||
      reasoningEffort === MCODE_REASONING_OFF ||
      reasoningEffort === "on"
    ) {
      return;
    }
    const efforts = getMcodeSelectOptions(
      client.getSessionConfigOptions(sessionId) as never,
      MCODE_EFFORT_CONFIG_ID,
    );
    if (efforts.current === reasoningEffort) return;
    if (!efforts.options.some((option) => option.value === reasoningEffort)) {
      throw new Error(
        `MiniMax Code model "${model}" does not support thinking effort "${reasoningEffort}"`,
      );
    }
    await client.setSessionConfigOption(
      sessionId,
      MCODE_EFFORT_CONFIG_ID,
      reasoningEffort,
    );
  }

  /**
   * mcode refuses a new turn while its own session Queue holds an earlier
   * message (`local_session_has_queued_messages`). That happens when a
   * questionnaire answer lands while the asking turn is still finishing: mcode
   * queues the answer and only an active ACP prompt would consume it. ACP has
   * no "continue queue" method, so fold the queued messages (in order) into
   * this prompt and remove them from the Queue, then retry once.
   */
  private async promptWithQueueRecovery(
    client: ACPClient,
    sessionId: string,
    blocks: ContentBlock[],
  ): Promise<PromptResponse> {
    try {
      return await client.prompt(sessionId, blocks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/queued message has priority/i.test(message)) throw error;
      const listed = (await client.requestExtension(
        "mcode/session/queue/list",
        {
          sessionId,
        },
      )) as { items?: unknown } | undefined;
      const items = Array.isArray(listed?.items)
        ? listed.items.filter(isRecord)
        : [];
      const texts: string[] = [];
      for (const item of items) {
        if (typeof item.itemId !== "string") continue;
        await client.requestExtension("mcode/session/queue/delete", {
          sessionId,
          itemId: item.itemId,
        });
        if (typeof item.content === "string" && item.content.trim()) {
          // Keep the readable Q/A summary of questionnaire answers; the XML
          // envelope would otherwise be shown verbatim as user text.
          texts.push(
            summarizeMcodeQuestionnaireResponse(item.content) ?? item.content,
          );
        }
      }
      log.info(
        { sessionId, recoveredQueueItems: texts.length },
        "MiniMax Code queued messages folded into the next prompt",
      );
      const [first, ...rest] = blocks;
      const merged: ContentBlock[] =
        first?.type === "text" && texts.length > 0
          ? [
              { type: "text", text: [...texts, first.text].join("\n\n") },
              ...rest,
            ]
          : blocks;
      return client.prompt(sessionId, merged);
    }
  }

  private async *streamPrompt(
    client: ACPClient,
    sessionId: string,
    blocks: ContentBlock[],
    updateQueue: SessionNotification[],
    toolNames: Map<string, string>,
    signal: AbortSignal,
    state: McodeSessionState,
  ): AsyncIterableIterator<SDKMessage> {
    state.questionnaireAnsweredAt = undefined;
    let promptDone = false;
    const promptPromise: Promise<PromptResponse> = this.promptWithQueueRecovery(
      client,
      sessionId,
      blocks,
    );
    void promptPromise.then(
      () => {
        promptDone = true;
      },
      () => {
        promptDone = true;
      },
    );

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

    while (!signal.aborted && (!promptDone || updateQueue.length > 0)) {
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
        if (update.sessionUpdate === "config_option_update") {
          continue;
        }
        const converted = convertMcodeUpdate(update, sessionId, toolNames);
        if (converted.length > 0) {
          yield* flushThinking();
          yield* flushText();
          yield* converted;
        }
      }
      // Cumulative snapshots reuse one uuid so streaming text updates a row.
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

    try {
      const result = await promptPromise;
      const answeredAt = state.questionnaireAnsweredAt;
      if (answeredAt !== undefined && result.stopReason === "end_turn") {
        state.questionnaireAnsweredAt = undefined;
        await waitForMcodeContinuation(client, sessionId, answeredAt, signal);
      }
      if (result.stopReason === "refusal") {
        yield {
          type: "error",
          session_id: sessionId,
          error:
            "MiniMax Code did not complete the turn: the request was refused.",
          errorCode: "mcode.acp.refusal",
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
        error: error instanceof Error ? error.message : String(error),
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
   * Route mcode tool approvals through Yep. mcode already applied its own
   * permission policy before asking, so Yep must not auto-approve again.
   */
  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (!options.onToolApproval) return { outcome: { outcome: "cancelled" } };
    const toolCall = request.toolCall;
    const questionnaireOptions = request.options.filter((option) =>
      option.optionId.startsWith("questionnaire:"),
    );

    // Single-step questionnaire fallback (only used when elicitation is not
    // negotiated): options are `questionnaire:<id>:<optionId>`.
    if (questionnaireOptions.length > 0) {
      const answerOptions = questionnaireOptions.filter(
        (option) => option.kind === "allow_once",
      );
      const questionId = "question-0";
      const result = await options.onToolApproval(
        "AskUserQuestion",
        {
          questions: [
            {
              id: questionId,
              question: toolCall.title ?? "MiniMax Code needs your input",
              header: "Question",
              options: answerOptions.map((option) => ({
                label: option.name,
                value: option.optionId,
                description: "",
              })),
              multiSelect: false,
              custom: false,
              required: true,
            },
          ],
        },
        { signal, respectProviderDecision: true },
      );
      const answers = isRecord(result.updatedInput)
        ? result.updatedInput.answers
        : undefined;
      const chosen = isRecord(answers) ? answers[questionId] : undefined;
      const match = answerOptions.find(
        (option) => option.optionId === chosen || option.name === chosen,
      );
      if (result.behavior === "allow" && match) {
        return { outcome: { outcome: "selected", optionId: match.optionId } };
      }
      const cancel = request.options.find(
        (option) => option.kind === "reject_once",
      );
      return cancel
        ? { outcome: { outcome: "selected", optionId: cancel.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const nativeName = readToolCallName(toolCall) ?? toolCall.title ?? "tool";
    const toolName = canonicalizeMcodeToolName(nativeName);
    const toolInput = {
      ...normalizeMcodeToolArguments(nativeName, toolCall.rawInput),
      ...(toolCall.locations ? { locations: toolCall.locations } : {}),
    };
    const result = await options.onToolApproval(toolName, toolInput, {
      signal,
      respectProviderDecision: true,
    });
    return convertApproval(result, request);
  }

  /** Structured questionnaire (`ask_user`) through ACP form elicitation. */
  private async handleElicitation(
    request: CreateElicitationRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
    state: McodeSessionState,
  ): Promise<CreateElicitationResponse> {
    if (!options.onToolApproval || request.mode !== "form") {
      return { action: "decline" };
    }
    const plan = planMcodeQuestionnaire(
      (request as { requestedSchema?: unknown }).requestedSchema,
      request.message,
    );
    if (!plan) {
      log.warn("MiniMax Code questionnaire schema was not understood");
      return { action: "decline" };
    }
    const result = await options.onToolApproval(
      "AskUserQuestion",
      { questions: plan.questions, title: request.message },
      { signal, respectProviderDecision: true },
    );
    if (result.behavior !== "allow") return { action: "decline" };
    const answers = isRecord(result.updatedInput)
      ? result.updatedInput.answers
      : undefined;
    if (!isRecord(answers)) return { action: "cancel" };
    if (state.promptActive) state.questionnaireAnsweredAt = Date.now();
    return {
      action: "accept",
      content: buildMcodeElicitationContent(plan, answers),
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
          // Fall through: the path still reaches mcode as a resource link.
        }
      }
      // mcode does not advertise embeddedContext; the attachment path is
      // already listed in the prompt text, so links are informational.
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

  private async findMcodePath(): Promise<string | null> {
    return findMcodePath(this.mcodePath);
  }
}

const CONTINUATION_POLL_MS = 1_000;
const CONTINUATION_TIMEOUT_MS = 15 * 60_000;
const CONTINUATION_IDLE_MS = 90_000;

/**
 * Wait until mcode's background continuation (started after a questionnaire
 * answer) has persisted a final assistant message. ACP emits no transcript
 * updates for that background turn, so `messages.jsonl` is the only
 * authoritative completion signal.
 */
async function waitForMcodeContinuation(
  client: ACPClient,
  sessionId: string,
  answeredAt: number,
  signal: AbortSignal,
): Promise<void> {
  const record = await findMcodeSessionRecord(sessionId);
  if (!record) return;
  const deadline = Date.now() + CONTINUATION_TIMEOUT_MS;
  let lastStamp = "";
  let lastProgressAt = Date.now();
  for (let poll = 0; !signal.aborted && Date.now() < deadline; poll += 1) {
    if (await isMcodeTurnSettledAfter(record.messagesPath, answeredAt)) return;
    const stats = await getMcodeTranscriptStats(record.messagesPath);
    const stamp = stats ? `${stats.mtime}:${stats.size}` : "";
    if (stamp !== lastStamp) {
      lastStamp = stamp;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > CONTINUATION_IDLE_MS) {
      return;
    }
    // An answer that raced the finishing turn is parked in mcode's Queue and
    // never starts a continuation; the next prompt folds it in instead.
    if (poll % 3 === 2 && (await hasQueuedMcodeMessages(client, sessionId))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CONTINUATION_POLL_MS));
  }
}

async function hasQueuedMcodeMessages(
  client: ACPClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const listed = (await client.requestExtension("mcode/session/queue/list", {
      sessionId,
    })) as { items?: unknown } | undefined;
    return Array.isArray(listed?.items) && listed.items.length > 0;
  } catch {
    return false;
  }
}

export async function isMcodeTurnSettledAfter(
  messagesPath: string,
  sinceMs: number,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(messagesPath, "utf8");
  } catch {
    return true;
  }
  const lines = raw.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let row: unknown;
    try {
      row = JSON.parse(lines[index] ?? "");
    } catch {
      continue;
    }
    const message = isRecord(row) && isRecord(row.message) ? row.message : null;
    if (!message) continue;
    const timestamp =
      typeof message.timestamp === "number" ? message.timestamp : 0;
    if (timestamp < sinceMs) return false;
    return (
      message.role === "assistant" &&
      message.stopReason !== "toolUse" &&
      message.stopReason !== "pending"
    );
  }
  return false;
}

function currentModelRef(
  client: ACPClient,
  sessionId: string,
): string | undefined {
  const current = getMcodeSelectOptions(
    client.getSessionConfigOptions(sessionId) as never,
    MCODE_MODEL_CONFIG_ID,
  ).current;
  if (!current) return undefined;
  const match = /^m:([^:]+):([^:]+):/.exec(current);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  } catch {
    return undefined;
  }
}

/** mcode adds a non-standard `name` next to `title` on permission requests. */
function readToolCallName(toolCall: unknown): string | undefined {
  return isRecord(toolCall) && typeof toolCall.name === "string"
    ? toolCall.name
    : undefined;
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
 * `mcode` is a `#!/usr/bin/env node` script that needs Node 22.19+/24+.
 * Services launched by launchd do not inherit nvm's PATH, so put the
 * directory holding the `mcode` link (which also holds its `node`) first.
 */
export function mcodeSpawnEnv(mcodePath: string): Record<string, string> {
  const binDir = dirname(mcodePath);
  const current = process.env.PATH ?? "";
  return {
    PATH: current ? `${binDir}${delimiter}${current}` : binDir,
  };
}

let cachedMcodePath: { at: number; path: string | null } | null = null;

export async function findMcodePath(explicit?: string): Promise<string | null> {
  const candidates = [explicit, process.env.MCODE_PATH?.trim()].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  if (cachedMcodePath && Date.now() - cachedMcodePath.at < 60_000) {
    return cachedMcodePath.path;
  }
  const remember = (path: string | null) => {
    cachedMcodePath = { at: Date.now(), path };
    return path;
  };

  const home = homedir();
  const installDir =
    process.env.MCODE_INSTALL_DIR?.trim() || join(home, ".minimax-code");
  const common = [
    join(installDir, "bin", "mcode"),
    join(home, ".local", "bin", "mcode"),
    "/opt/homebrew/bin/mcode",
    "/usr/local/bin/mcode",
  ];
  for (const path of common) {
    if (existsSync(path)) return remember(path);
  }
  try {
    const { stdout } = await execAsync(whichCommand("mcode"), {
      encoding: "utf-8",
    });
    const result = stdout.trim().split("\n")[0]?.trim();
    if (result && existsSync(result)) return remember(result);
  } catch {
    // Not on PATH (typical for launchd services with nvm installs).
  }
  // nvm global installs: ~/.nvm/versions/node/<version>/bin/mcode
  try {
    const nvmRoot = join(
      process.env.NVM_DIR?.trim() || join(home, ".nvm"),
      "versions",
      "node",
    );
    const versions = readdirSync(nvmRoot).sort().reverse();
    for (const version of versions) {
      const path = join(nvmRoot, version, "bin", "mcode");
      if (existsSync(path)) return remember(path);
    }
  } catch {
    // No nvm installation.
  }
  return remember(null);
}

export const mcodeProvider = new McodeProvider();
