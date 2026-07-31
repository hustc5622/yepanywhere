/**
 * Kimi ACP Provider implementation using Agent Client Protocol.
 *
 * Kimi Code CLI ships a first-class ACP server (`kimi acp`) that is richer
 * than Gemini's: it supports session/new, session/load (history replay),
 * session/resume, configOptions (model + mode selection) and terminal-auth.
 *
 * Like Gemini, Kimi executes its own tools internally and only asks for
 * permission on sensitive operations. This provider routes those ACP
 * `session/request_permission` requests through yepanywhere's approval flow
 * (the same in-process path Gemini uses) — no standalone bridge process is
 * required, unlike the Codex (4510) / OpenCode (4520) bridges.
 *
 * Session content modification (fork / branch / rollback) is intentionally
 * not implemented in this phase: Kimi only exposes fork/undo through its
 * node-sdk / kap-server REST surface, never over ACP. See
 * docs/project/kimi-cli-integration.md.
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@yep-anywhere/shared";
import { normalizeKimiToolInput } from "../../kimi/tool-input.js";
import { getLogger } from "../../logging/logger.js";
import { whichCommand } from "../cli-detection.js";
const execAsync = promisify(exec);
import { MessageQueue } from "../messageQueue.js";
import type {
  CanUseTool,
  PermissionMode,
  SDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../types.js";
import { ACPClient } from "./acp/client.js";
import {
  type KimiDetectedCapability,
  type KimiProviderType,
  getKimiModelCapability,
  isUnknownDetectedCapability,
} from "./kimi-capability-registry.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

/** Kimi home directory (config + sessions live here). */
const KIMI_HOME = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
/** Kimi global config file. */
const KIMI_CONFIG_PATH = join(KIMI_HOME, "config.toml");

/**
 * Fallback model list used when config.toml cannot be parsed. The real
 * catalog is derived from `[models."..."]` sections in config.toml.
 */
const KIMI_FALLBACK_MODELS: ModelInfo[] = [{ id: "kimi-k3", name: "Kimi K3" }];

export type KimiAcpMode = "default" | "plan" | "auto" | "yolo";

/**
 * Map Yep's shared permission values onto Kimi's native ACP mode taxonomy.
 *
 * `bypassPermissions` remains the shared wire value for compatibility, but
 * Kimi presents and executes it as YOLO. `acceptEdits` is an older Yep-managed
 * extension with no native Kimi equivalent, so old saved values safely fall
 * back to manual/default and let Yep approve edits selectively.
 */
export function toKimiAcpMode(mode: PermissionMode): KimiAcpMode {
  switch (mode) {
    case "plan":
      return "plan";
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "yolo";
    default:
      return "default";
  }
}

interface KimiSessionState {
  sessionId: string | null;
  permissionMode: PermissionMode;
  /** Set once the image-not-supported warning has been surfaced. */
  imageWarningEmitted?: boolean;
}

/**
 * Whether the resolved Kimi model accepts image input.
 *
 * Kimi resolves capabilities as `declared ∪ detected` (union semantics):
 * `image_in = declared.has('image_in') || detected.image_in`. Declared
 * capabilities come from `config.toml` `[models."X"].capabilities` or the
 * `KIMI_MODEL_CAPABILITIES` env overlay; detected capabilities come from a
 * static prefix table keyed by `(provider wire type, model id)` — see
 * `kimi-capability-registry.ts`.
 *
 * - `supported`   — either `image_in` is explicitly declared, or the static
 *   catalog detects the model as vision-capable (e.g. `gpt-4o`,
 *   `claude-3-*`, `gemini-2.5-*`).
 * - `unsupported` — the static catalog knows the model and explicitly
 *   reports `image_in: false` (e.g. `o3-mini` reasoning, `gpt-3.5-turbo`),
 *   AND no `image_in` was declared. Kimi will drop images in this case.
 * - `unknown`     — neither declared nor detected can determine the answer
 *   (model is uncatalogued or the provider type is missing). Kimi falls
 *   back to catalog auto-detection (`models.dev`) or the managed server
 *   registry, which we cannot reproduce here.
 */
export type KimiImageSupport = "supported" | "unsupported" | "unknown";

/**
 * Read the `capabilities` list of one `[models."<alias>"]` section.
 * Returns null when the section (or the key) is absent — Kimi then relies on
 * catalog detection rather than on a declaration.
 */
function parseKimiModelCapabilities(
  configToml: string,
  modelId: string,
): string[] | null {
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `^\\s*\\[models\\.(?:"${escaped}"|${escaped})\\]\\s*$`,
    "m",
  );
  const start = sectionRe.exec(configToml);
  if (!start) return null;

  const rest = configToml.slice(start.index + start[0].length);
  // Stop at the next top-level section so a sibling model's list is not read.
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  const body = nextSection ? rest.slice(0, nextSection.index) : rest;

  const capsRe = /^\s*capabilities\s*=\s*\[([^\]]*)\]/m;
  const caps = capsRe.exec(body);
  if (!caps) return null;

  return (caps[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Read `default_model = "..."` from config.toml. */
function parseKimiDefaultModel(configToml: string): string | undefined {
  const match = /^\s*default_model\s*=\s*["']([^"']+)["']/m.exec(configToml);
  return match?.[1];
}

/**
 * Read `provider = "..."` from one `[models."<alias>"]` section.
 * Returns null when the section or the key is absent.
 */
function parseKimiModelProvider(
  configToml: string,
  modelId: string,
): string | null {
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `^\\s*\\[models\\.(?:"${escaped}"|${escaped})\\]\\s*$`,
    "m",
  );
  const start = sectionRe.exec(configToml);
  if (!start) return null;

  const rest = configToml.slice(start.index + start[0].length);
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  const body = nextSection ? rest.slice(0, nextSection.index) : rest;

  const providerRe = /^\s*provider\s*=\s*["']([^"']+)["']/m;
  return providerRe.exec(body)?.[1] ?? null;
}

/**
 * Read `model = "..."` (the wire model id) from one `[models."<alias>"]`
 * section. Returns null when the section or the key is absent.
 */
function parseKimiModelWireId(
  configToml: string,
  modelId: string,
): string | null {
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `^\\s*\\[models\\.(?:"${escaped}"|${escaped})\\]\\s*$`,
    "m",
  );
  const start = sectionRe.exec(configToml);
  if (!start) return null;

  const rest = configToml.slice(start.index + start[0].length);
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  const body = nextSection ? rest.slice(0, nextSection.index) : rest;

  const modelRe = /^\s*model\s*=\s*["']([^"']+)["']/m;
  return modelRe.exec(body)?.[1] ?? null;
}

/**
 * Read `type = "..."` from one `[providers."<name>"]` section.
 * Returns null when the section or the key is absent.
 */
function parseKimiProviderType(
  configToml: string,
  providerName: string,
): KimiProviderType | null {
  const escaped = providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRe = new RegExp(
    `^\\s*\\[providers\\.(?:"${escaped}"|${escaped})\\]\\s*$`,
    "m",
  );
  const start = sectionRe.exec(configToml);
  if (!start) return null;

  const rest = configToml.slice(start.index + start[0].length);
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  const body = nextSection ? rest.slice(0, nextSection.index) : rest;

  const typeRe = /^\s*type\s*=\s*["']([^"']+)["']/m;
  const match = typeRe.exec(body)?.[1];
  if (!match) return null;
  const known: KimiProviderType[] = [
    "anthropic",
    "openai",
    "openai_responses",
    "google-genai",
    "vertexai",
    "kimi",
  ];
  return known.includes(match as KimiProviderType)
    ? (match as KimiProviderType)
    : null;
}

/**
 * Resolve the detected capability for a model alias by looking up its
 * provider type and wire model id in the static catalog.
 *
 * Returns `null` when the provider type or wire model id cannot be resolved
 * from config.toml, or when the catalog returns UNKNOWN — in those cases
 * we cannot make an authoritative negative statement.
 */
function resolveDetectedCapability(
  configToml: string,
  aliasId: string,
): KimiDetectedCapability | null {
  const providerName = parseKimiModelProvider(configToml, aliasId);
  if (!providerName) return null;
  const providerType = parseKimiProviderType(configToml, providerName);
  if (!providerType) return null;
  const wireModelId = parseKimiModelWireId(configToml, aliasId);
  if (!wireModelId) return null;

  const detected = getKimiModelCapability(providerType, wireModelId);
  if (isUnknownDetectedCapability(detected)) return null;
  return detected;
}

/**
 * Merge declared and detected capabilities, mirroring Kimi's union semantics:
 * `image_in = declared.includes('image_in') || detected.image_in`.
 *
 * Returns `supported` when either source reports `image_in`. Returns
 * `unsupported` only when the detected catalog explicitly knows the model
 * and reports `image_in: false` (authoritative negative). Returns `unknown`
 * when neither source can determine the answer.
 */
function mergeImageSupport(
  declaredHasImageIn: boolean,
  detected: KimiDetectedCapability | null,
): KimiImageSupport {
  if (declaredHasImageIn) return "supported";
  if (!detected) return "unknown";
  return detected.image_in ? "supported" : "unsupported";
}

/**
 * Resolve whether images will actually reach the model for this session.
 *
 * Mirrors Kimi's own precedence: an explicit `-m <alias>` wins, then the
 * `KIMI_MODEL_*` env overlay (which defaults to `image_in,thinking`), then
 * `default_model` from config.toml. Capabilities are merged as
 * `declared ∪ detected` — see KimiImageSupport for the full semantics.
 */
export function resolveKimiImageSupport(
  configToml: string | null,
  modelId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): KimiImageSupport {
  // Env overlay path: when KIMI_MODEL_NAME is set and no explicit -m alias
  // is provided, the overlay synthesizes an alias with declared capabilities
  // from KIMI_MODEL_CAPABILITIES (default: image_in,thinking). The env
  // overlay has no provider type / wire model id, so detected is null —
  // the overlay's declared list is the sole source of truth.
  if (!modelId && env.KIMI_MODEL_NAME) {
    const declared = env.KIMI_MODEL_CAPABILITIES?.trim();
    if (!declared) return "supported"; // overlay default is image_in,thinking
    const caps = declared
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    return mergeImageSupport(caps.includes("image_in"), null);
  }

  if (!configToml) return "unknown";
  const target = modelId ?? parseKimiDefaultModel(configToml);
  if (!target) return "unknown";

  const caps = parseKimiModelCapabilities(configToml, target);
  const declaredHasImageIn = caps?.includes("image_in") ?? false;
  const detected = resolveDetectedCapability(configToml, target);
  return mergeImageSupport(declaredHasImageIn, detected);
}

/** Warning surfaced in the transcript when images cannot reach the model. */
export function kimiImageDropWarning(modelId: string): string {
  return [
    `Kimi model "${modelId}" does not declare image input, so the attached image was not shown to it.`,
    `Add "image_in" to that model's \`capabilities\` in ${KIMI_CONFIG_PATH}, or pick a vision-capable model.`,
  ].join(" ");
}

/**
 * Configuration for the Kimi ACP provider.
 */
export interface KimiProviderConfig {
  /** Path to the kimi binary (auto-detected if not specified). */
  kimiPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Kimi's ACP adapter uses either the original tool name or a human-readable
 * description as `title`. Prefer an exact name, then combine distinctive
 * native arguments with the description/kind metadata.
 */
function inferKimiAcpToolName(
  kind: ToolKind | null | undefined,
  title: string | null | undefined,
  rawInput: unknown,
): string {
  const input = isRecord(rawInput) ? rawInput : {};
  const trimmedTitle = title?.trim();
  const lowerTitle = trimmedTitle?.toLowerCase() ?? "";
  const exactNames: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    glob: "Glob",
    grep: "Grep",
    read: "Read",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    write: "Write",
  };
  const exactName = exactNames[lowerTitle];
  if (exactName) return exactName;

  if ("old_string" in input || "new_string" in input) return "Edit";
  if (typeof input.path === "string" && typeof input.content === "string") {
    return "Write";
  }
  if (typeof input.command === "string") return "Bash";
  if (typeof input.pattern === "string") {
    // Kimi Glob and Grep both accept `pattern` and optional `path`. The ACP
    // adapter preserves their distinct descriptions (`Searching …` versus
    // `Searching for …`), while only Grep exposes the fields below.
    if (lowerTitle.startsWith("searching for ")) return "Grep";
    if (lowerTitle.startsWith("searching ")) return "Glob";
    if (
      typeof input.output_mode === "string" ||
      typeof input.glob === "string" ||
      typeof input.type === "string" ||
      "-i" in input ||
      "-A" in input ||
      "-B" in input ||
      "-C" in input ||
      "-n" in input ||
      "head_limit" in input ||
      "offset" in input ||
      "multiline" in input
    ) {
      return "Grep";
    }
    return "Glob";
  }
  if (
    typeof input.path === "string" &&
    (kind === "read" ||
      typeof input.line_offset === "number" ||
      typeof input.n_lines === "number")
  ) {
    return "Read";
  }
  if (typeof input.url === "string") return "WebFetch";
  if (typeof input.query === "string") return "WebSearch";

  if (lowerTitle.startsWith("reading ")) return "Read";
  if (lowerTitle.startsWith("writing ")) return "Write";
  if (lowerTitle.startsWith("editing ")) return "Edit";
  if (lowerTitle.startsWith("running:")) return "Bash";
  if (lowerTitle.startsWith("searching for ")) return "Grep";
  if (lowerTitle.startsWith("searching ")) return "Glob";

  switch (kind) {
    case "execute":
      return "Bash";
    case "read":
      return "Read";
    case "fetch":
      return "WebFetch";
    case "think":
      return "Think";
    default:
      return trimmedTitle || "KimiTool";
  }
}

function stringifyKimiAcpValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getKimiAcpToolOutput(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): string {
  const textParts: string[] = [];
  for (const item of update.content ?? []) {
    if (
      item.type === "content" &&
      item.content.type === "text" &&
      item.content.text
    ) {
      textParts.push(item.content.text);
    }
  }
  if (textParts.length > 0) return textParts.join("\n");
  return stringifyKimiAcpValue(update.rawOutput);
}

/**
 * Kimi ACP Provider implementation.
 *
 * Uses `kimi acp` (ACP over stdio). The agent controls its own tool loop;
 * we only handle permission requests and stream session updates back as
 * SDKMessages.
 */
export class KimiProvider implements AgentProvider {
  readonly name: ProviderName = "kimi";
  readonly displayName = "Kimi";
  // ACP permission requests are routed through Yep's approval flow.
  readonly supportsPermissionMode = true;
  readonly permissionModes = [
    "default",
    "plan",
    "auto",
    "bypassPermissions",
  ] as const;
  // Kimi exposes thinking effort levels via config; a simple toggle is not
  // the right surface, so keep it off for the initial integration.
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly kimiPath?: string;
  private log = getLogger();

  constructor(config: KimiProviderConfig = {}) {
    this.kimiPath = config.kimiPath;
  }

  async isInstalled(): Promise<boolean> {
    const path = await this.findKimiPath();
    return path !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Detailed auth status.
   *
   * Kimi stores credentials/config under ~/.kimi-code. For the initial
   * integration we treat a config.toml that declares a provider or an
   * api_key (managed OAuth also writes here) as "authenticated". A full
   * device-code login check can be layered on later.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return { installed: false, authenticated: false, enabled: false };
    }

    if (!existsSync(KIMI_CONFIG_PATH)) {
      return { installed: true, authenticated: false, enabled: false };
    }

    try {
      const config = readFileSync(KIMI_CONFIG_PATH, "utf-8");
      const configured =
        /\bapi_key\s*=/.test(config) || /\[providers\./.test(config);
      return {
        installed: true,
        authenticated: configured,
        enabled: configured,
      };
    } catch {
      return { installed: true, authenticated: false, enabled: false };
    }
  }

  /**
   * Available models, derived from `[models."..."]` sections in config.toml.
   * Falls back to a static list when the config cannot be read/parsed.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    if (!existsSync(KIMI_CONFIG_PATH)) {
      return KIMI_FALLBACK_MODELS;
    }
    try {
      const config = readFileSync(KIMI_CONFIG_PATH, "utf-8");
      const models = this.parseModelIds(config);
      return models.length > 0 ? models : KIMI_FALLBACK_MODELS;
    } catch {
      return KIMI_FALLBACK_MODELS;
    }
  }

  /**
   * Extract model alias ids from `[models."<id>"]` TOML section headers.
   * Lightweight, dependency-free — sufficient for the picker.
   */
  private parseModelIds(configToml: string): ModelInfo[] {
    const ids = new Set<string>();
    const sectionRe = /^\s*\[models\.(?:"([^"]+)"|([^\]\s.]+))\]/gm;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((match = sectionRe.exec(configToml)) !== null) {
      const id = match[1] ?? match[2];
      if (id) ids.add(id);
    }
    return Array.from(ids, (id) => ({ id, name: this.modelDisplayName(id) }));
  }

  /** Human-friendly label for a model alias id like "custom-kimi/kimi-k3". */
  private modelDisplayName(id: string): string {
    const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    return tail;
  }

  /** Read config.toml, or null when it is missing/unreadable. */
  private readKimiConfig(): string | null {
    if (!existsSync(KIMI_CONFIG_PATH)) return null;
    try {
      return readFileSync(KIMI_CONFIG_PATH, "utf-8");
    } catch {
      return null;
    }
  }

  /** The model alias that will be used when the session does not pin one. */
  private resolveConfiguredModel(): string | undefined {
    if (process.env.KIMI_MODEL_NAME) return process.env.KIMI_MODEL_NAME;
    const config = this.readKimiConfig();
    return config ? parseKimiDefaultModel(config) : undefined;
  }

  /** Whether images sent to this session will actually reach the model. */
  private resolveImageSupport(modelId: string | undefined): KimiImageSupport {
    return resolveKimiImageSupport(this.readKimiConfig(), modelId);
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    // Attachments are kept on the queued message so buildPromptBlocks can turn
    // them into native ACP image / resource_link blocks.
    const queue = new MessageQueue({ preserveAttachments: true });
    const abortController = new AbortController();
    const sessionState: KimiSessionState = {
      sessionId: null,
      permissionMode: options.permissionMode ?? "default",
    };

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const client = new ACPClient();
    const iterator = this.runSession(
      client,
      options,
      queue,
      sessionState,
      abortController.signal,
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        client.close();
      },
      // Report child-process liveness so the supervisor's stale-process
      // watchdog does not kill a healthy Kimi process during long silent
      // spans — e.g. while an AgentSwarm/explore subagent runs for minutes,
      // the parent ACP prompt emits no SDK messages but the process is alive.
      // Without this the watchdog falls back to a time-based heuristic and
      // terminates the process, aborting the in-flight turn.
      isProcessAlive: () => client.isAlive(),
      get pid() {
        return client.pid;
      },
      setPermissionMode: async (mode) => {
        if (!sessionState.sessionId) {
          throw new Error("Kimi ACP session is not initialized yet");
        }
        await client.setSessionMode(
          sessionState.sessionId,
          toKimiAcpMode(mode),
        );
        sessionState.permissionMode = mode;
      },
    };
  }

  /**
   * Main session loop using the ACP protocol.
   */
  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    sessionState: KimiSessionState,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const kimiPath = await this.findKimiPath();
    if (!kimiPath) {
      yield {
        type: "error",
        error:
          "Kimi CLI not found. Install it from https://moonshotai.github.io/kimi-code/",
      } as SDKMessage;
      return;
    }

    // `kimi acp` runs the ACP server; the global `-m` flag (accepted before
    // the subcommand) selects the model alias for this invocation. Thinking
    // effort is not exposed as a CLI flag, so it falls back to the model's
    // config.toml default; per-session effort override would require ACP
    // configOptions support in ACPClient.
    const args: string[] = [];
    if (options.model) {
      args.push("-m", options.model);
    }
    args.push("acp");

    // Collect session updates to convert to SDKMessages.
    const updateQueue: SessionNotification[] = [];
    let updateResolver: (() => void) | null = null;
    client.setSessionUpdateCallback((update) => {
      updateQueue.push(update);
      if (updateResolver) {
        updateResolver();
        updateResolver = null;
      }
    });

    this.log.debug(
      { hasOnToolApproval: !!options.onToolApproval },
      "Setting up Kimi ACP permission handler",
    );
    if (options.onToolApproval) {
      client.setPermissionRequestCallback(async (request) =>
        this.handlePermissionRequest(
          request,
          options,
          sessionState.permissionMode,
          signal,
        ),
      );
    } else {
      this.log.warn(
        "No onToolApproval callback provided - Kimi permissions will be auto-denied",
      );
    }

    try {
      const connectStart = Date.now();
      await client.connect({ command: kimiPath, args, cwd: options.cwd });
      this.log.info(
        { durationMs: Date.now() - connectStart },
        "Kimi ACP connected (kimi acp)",
      );

      const initStart = Date.now();
      const initResult = await client.initialize({});
      // Logged for diagnostics only. Kimi's ACP layer always advertises
      // `image: true`; whether the pixels actually reach the model depends on
      // the resolved model's `image_in` capability (config.toml `capabilities`
      // or catalog detection). When it is missing, Kimi silently substitutes
      // "[image omitted: current model has no image input]" before the LLM call.
      this.log.debug(
        {
          durationMs: Date.now() - initStart,
          promptCapabilities: initResult.agentCapabilities?.promptCapabilities,
        },
        "Kimi ACP initialized",
      );

      // Create or resume the ACP session.
      let sessionId: string;
      if (options.resumeSessionId) {
        try {
          sessionId = await client.resumeSession(
            options.resumeSessionId,
            options.cwd,
          );
          this.log.debug({ sessionId }, "Kimi ACP session resumed");
        } catch (resumeErr) {
          this.log.warn(
            { err: resumeErr, resumeSessionId: options.resumeSessionId },
            "Failed to resume Kimi ACP session, creating new session",
          );
          sessionId = await client.newSession(options.cwd);
          this.log.debug(
            { sessionId, originalSessionId: options.resumeSessionId },
            "Created new Kimi ACP session (resume failed)",
          );
        }
      } else {
        sessionId = await client.newSession(options.cwd);
        this.log.debug({ sessionId }, "Kimi ACP session created");
      }

      sessionState.sessionId = sessionId;
      const kimiMode = toKimiAcpMode(sessionState.permissionMode);
      await client.setSessionMode(sessionId, kimiMode);
      this.log.debug(
        { sessionId, permissionMode: sessionState.permissionMode, kimiMode },
        "Kimi ACP native mode applied",
      );

      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
      } as SDKMessage;

      const messageGen = queue.generator();
      let isFirstNewMessage = true;
      for await (const message of messageGen) {
        if (signal.aborted) break;

        let userText = this.extractTextFromMessage(message);

        if (isFirstNewMessage && options.globalInstructions) {
          userText = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userText}`;
        }
        isFirstNewMessage = false;

        const userUuid = (message as { uuid?: string }).uuid ?? randomUUID();
        yield {
          type: "user",
          uuid: userUuid,
          session_id: sessionId,
          message: { role: "user", content: userText },
        } as SDKMessage;

        updateQueue.length = 0;

        const promptBlocks = await this.buildPromptBlocks(message, userText);
        const imageBlockCount = promptBlocks.filter(
          (b) => b.type === "image",
        ).length;
        const promptStart = Date.now();
        this.log.debug(
          {
            textLength: userText.length,
            blockCount: promptBlocks.length,
            imageBlocks: imageBlockCount,
            resourceLinks: promptBlocks.filter(
              (b) => b.type === "resource_link",
            ).length,
          },
          "Sending prompt to Kimi",
        );

        // Kimi's ACP layer accepts images unconditionally but drops them right
        // before the LLM call when the resolved model lacks `image_in`. This
        // is only an authoritative negative when the static catalog knows
        // the model and reports `image_in: false` (e.g. o3-mini,
        // gpt-3.5-turbo). A merely `unknown` model may still accept images
        // via Kimi's catalog auto-detection, so no warning is emitted then.
        if (imageBlockCount > 0 && !sessionState.imageWarningEmitted) {
          const support = this.resolveImageSupport(options.model);
          if (support === "unsupported") {
            sessionState.imageWarningEmitted = true;
            const modelId =
              options.model ?? this.resolveConfiguredModel() ?? "";
            this.log.warn(
              { model: modelId, imageBlocks: imageBlockCount },
              "Kimi model does not declare image_in; images will be dropped",
            );
            yield {
              type: "system",
              subtype: "warning",
              session_id: sessionId,
              content: kimiImageDropWarning(modelId),
              warningKind: "kimi_image_input_unsupported",
            } as SDKMessage;
          }
        }

        const promptPromise = client.prompt(sessionId, promptBlocks);

        for await (const msg of this.yieldUpdates(
          promptPromise,
          updateQueue,
          sessionId,
          signal,
        )) {
          yield msg;
        }
        this.log.debug(
          { durationMs: Date.now() - promptStart },
          "Kimi prompt complete",
        );

        yield { type: "result", session_id: sessionId } as SDKMessage;
      }
    } catch (err) {
      this.log.error({ err }, "Kimi ACP session error");
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      } as SDKMessage;
    } finally {
      client.close();
    }
  }

  /**
   * Handle an ACP permission request by routing to Yep's approval flow.
   */
  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    permissionMode: PermissionMode,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const { onToolApproval } = options;
    if (!onToolApproval) {
      return { outcome: { outcome: "cancelled" } };
    }

    const toolCall = request.toolCall;
    const kind = toolCall.kind ?? "other";

    const toolName = this.mapKindToToolName(kind, toolCall.title ?? undefined);
    const toolInput = {
      kind,
      title: toolCall.title,
      locations: toolCall.locations,
      content: toolCall.content,
      rawInput: toolCall.rawInput,
      // Surface the agent's offered options (e.g. plan_review A/B/C, revise,
      // reject) so the approval UI can display them. Multi-select routing is
      // future work; allow/deny maps to approve/reject below.
      options: request.options,
    };

    this.log.debug(
      { toolName, toolInput },
      "Requesting user approval for Kimi ACP permission",
    );

    const result = await onToolApproval(toolName, toolInput, {
      signal,
      // Except for the legacy acceptEdits extension, Kimi has already applied
      // its native mode before emitting this request. In particular, YOLO
      // still emits sensitive actions, questions, and plan review; those must
      // reach the user instead of being auto-approved a second time by Yep.
      respectProviderDecision: permissionMode !== "acceptEdits",
    });
    return this.convertApprovalResultToACPResponse(result, request);
  }

  /**
   * Map an ACP tool kind to a human-readable tool name for the approval UI.
   */
  private mapKindToToolName(
    kind: ToolKind | null | undefined,
    title?: string,
  ): string {
    switch (kind) {
      case "edit":
        return "Write";
      case "delete":
        return "Delete";
      case "move":
        return "Move";
      case "execute":
        return "Bash";
      case "read":
        return "Read";
      case "search":
        return "Search";
      case "fetch":
        return "WebFetch";
      case "think":
        return "Think";
      case "switch_mode":
        return title ?? "SwitchMode";
      default:
        return title ?? "KimiTool";
    }
  }

  /**
   * Convert a Yep ToolApprovalResult into an ACP RequestPermissionResponse.
   *
   * Kimi advertises standard ACP option kinds. On approve we pick an
   * allow option (for plan_review, `allow_once` is the first plan option =
   * approve the plan). On deny we prefer a reject option (`reject_once` /
   * plan `Revise` / `Reject and Exit`) so rejection is semantically correct;
   * only when no reject option is offered do we fall back to `cancelled`.
   */
  private convertApprovalResultToACPResponse(
    result: ToolApprovalResult,
    request: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (result.behavior === "allow") {
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      const allowAlwaysOption = request.options.find(
        (o) => o.kind === "allow_always",
      );
      const selectedOption = allowOnceOption ?? allowAlwaysOption;

      if (selectedOption) {
        return {
          outcome: { outcome: "selected", optionId: selectedOption.optionId },
        };
      }
      return { outcome: { outcome: "selected", optionId: "approve_once" } };
    }

    // Deny: prefer an explicit reject option when the agent offers one.
    const rejectOption = request.options.find(
      (o) => o.kind === "reject_once" || o.kind === "reject_always",
    );
    if (rejectOption) {
      return {
        outcome: { outcome: "selected", optionId: rejectOption.optionId },
      };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  /**
   * Async generator yielding session updates as SDKMessages.
   */
  private async *yieldUpdates(
    promptPromise: Promise<unknown>,
    updateQueue: SessionNotification[],
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    let promptDone = false;
    promptPromise
      .then(() => {
        promptDone = true;
      })
      .catch((err) => {
        promptDone = true;
        this.log.error({ err }, "Kimi prompt error");
      });

    let assistantTextBuffer = "";
    let assistantMessageId: string | null = null;
    let thinkingTextBuffer = "";
    let thinkingMessageId: string | null = null;
    let thinkingDirty = false;
    const createThinkingSnapshot = (): SDKMessage => ({
      type: "assistant",
      uuid: thinkingMessageId ?? undefined,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: thinkingTextBuffer }],
      },
    });

    // A terminal tool update is commonly queued immediately before the prompt
    // response resolves. Drain those already-received notifications so the
    // final result is not lost at the turn boundary.
    while (!signal.aborted && (!promptDone || updateQueue.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 50));

      while (updateQueue.length > 0) {
        const notification = updateQueue.shift();
        if (!notification) break;

        const sessionUpdate = notification.update;

        if (
          sessionUpdate.sessionUpdate === "agent_thought_chunk" &&
          sessionUpdate.content.type === "text"
        ) {
          // A reasoning stream starts a new visual block, so finish any buffered
          // assistant text before switching into Kimi's reasoning stream.
          if (assistantTextBuffer) {
            yield {
              type: "assistant",
              uuid: assistantMessageId ?? undefined,
              session_id: sessionId,
              message: { role: "assistant", content: assistantTextBuffer },
            } as SDKMessage;
            assistantTextBuffer = "";
            assistantMessageId = null;
          }

          thinkingTextBuffer += sessionUpdate.content.text;
          thinkingMessageId ??= randomUUID();
          thinkingDirty = true;
          continue;
        }

        if (
          sessionUpdate.sessionUpdate === "agent_message_chunk" &&
          "content" in sessionUpdate
        ) {
          // Keep every contiguous Kimi reasoning stream under one UUID.
          // Cumulative snapshots then merge into one Thinking row client-side.
          if (thinkingTextBuffer) {
            if (thinkingDirty) {
              yield createThinkingSnapshot();
            }
            thinkingTextBuffer = "";
            thinkingMessageId = null;
            thinkingDirty = false;
          }

          const content = sessionUpdate.content;
          if (content && typeof content === "object" && "type" in content) {
            if (content.type === "text" && "text" in content) {
              assistantTextBuffer += content.text;
              if (!assistantMessageId) {
                assistantMessageId = randomUUID();
              }
            }
          }
          continue;
        }

        if (thinkingTextBuffer) {
          if (thinkingDirty) {
            yield createThinkingSnapshot();
          }
          thinkingTextBuffer = "";
          thinkingMessageId = null;
          thinkingDirty = false;
        }

        if (assistantTextBuffer) {
          yield {
            type: "assistant",
            uuid: assistantMessageId ?? undefined,
            session_id: sessionId,
            message: { role: "assistant", content: assistantTextBuffer },
          } as SDKMessage;
          assistantTextBuffer = "";
          assistantMessageId = null;
        }

        const sdkMessage = this.convertUpdateToSDKMessage(
          sessionUpdate,
          sessionId,
        );
        if (sdkMessage) {
          yield sdkMessage;
        }
      }

      // Keep reasoning visible while it streams. Each snapshot is cumulative
      // and reuses the same UUID, so even chunks arriving in different polling
      // windows update one row instead of creating one row per token.
      if (thinkingDirty && thinkingTextBuffer) {
        yield createThinkingSnapshot();
        thinkingDirty = false;
      }
    }

    if (thinkingDirty && thinkingTextBuffer) {
      yield createThinkingSnapshot();
    }

    if (assistantTextBuffer) {
      yield {
        type: "assistant",
        uuid: assistantMessageId ?? undefined,
        session_id: sessionId,
        message: { role: "assistant", content: assistantTextBuffer },
      } as SDKMessage;
    }
  }

  /**
   * Convert an ACP session update into an SDKMessage.
   */
  private convertUpdateToSDKMessage(
    update: SessionUpdate,
    sessionId: string,
  ): SDKMessage | null {
    const updateType = update.sessionUpdate;

    switch (updateType) {
      case "agent_message_chunk": {
        if ("content" in update) {
          const contentBlock = update.content;
          if (
            contentBlock &&
            typeof contentBlock === "object" &&
            "type" in contentBlock &&
            contentBlock.type === "text" &&
            "text" in contentBlock
          ) {
            return {
              type: "assistant",
              uuid: randomUUID(),
              session_id: sessionId,
              message: {
                role: "assistant",
                content: contentBlock.text as string,
              },
            } as SDKMessage;
          }
        }
        return null;
      }

      case "agent_thought_chunk": {
        if (
          update.content.type === "text" &&
          typeof update.content.text === "string"
        ) {
          return {
            type: "assistant",
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: update.content.text }],
            },
          } as SDKMessage;
        }
        return null;
      }

      case "tool_call": {
        const name = inferKimiAcpToolName(
          update.kind,
          update.title,
          update.rawInput,
        );
        const rawInput = isRecord(update.rawInput) ? update.rawInput : {};
        return {
          type: "assistant",
          uuid: randomUUID(),
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: update.toolCallId,
                name,
                input: normalizeKimiToolInput(name, rawInput),
              },
            ],
          },
        } as SDKMessage;
      }

      case "tool_call_update": {
        if (update.status === "completed" || update.status === "failed") {
          return {
            type: "user",
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: update.toolCallId,
                  content: getKimiAcpToolOutput(update),
                  ...(update.status === "failed" && { is_error: true }),
                },
              ],
            },
          } as SDKMessage;
        }

        // Kimi may lazy-create a tool from an arguments delta and attach the
        // parsed `rawInput` only in a later in-progress update. Replay the same
        // tool id with the richer payload; preprocessing deduplicates by id.
        if (isRecord(update.rawInput)) {
          const name = inferKimiAcpToolName(
            update.kind,
            update.title,
            update.rawInput,
          );
          return {
            type: "assistant",
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: update.toolCallId,
                  name,
                  input: normalizeKimiToolInput(name, update.rawInput),
                },
              ],
            },
          } as SDKMessage;
        }
        return null;
      }

      case "plan": {
        if (update.entries.length > 0) {
          const planText = update.entries
            .map((entry) => {
              const marker =
                entry.status === "completed"
                  ? "x"
                  : entry.status === "in_progress"
                    ? ">"
                    : " ";
              return `- [${marker}] ${entry.content}`;
            })
            .join("\n");
          return {
            type: "assistant",
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: planText }],
            },
          } as SDKMessage;
        }
        return null;
      }

      default:
        this.log.trace(
          { updateType, update },
          "Unhandled Kimi ACP update type",
        );
        return null;
    }
  }

  /**
   * Build the ACP prompt blocks for one queued user message.
   *
   * `text` is always sent first (it already carries the human-readable
   * "User uploaded files:" listing appended by MessageQueue, which the client
   * parses back into attachment chips and which lets Kimi re-read an original
   * at full fidelity via ReadMediaFile). Media is then attached natively:
   *
   * - inline base64 image blocks (REST `images[]`, pasted screenshots) become
   *   ACP `image` blocks;
   * - uploaded `image/*` attachments are read from disk into `image` blocks;
   * - every other attachment becomes a `resource_link`, which Kimi's adapter
   *   turns into a clean path reference for its Read tool.
   *
   * Kimi owns downscaling and original-preservation on its side
   * (`compressPromptImageParts`), so full-size bytes are sent as-is.
   */
  private async buildPromptBlocks(
    message: unknown,
    text: string,
  ): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [{ type: "text", text }];
    if (!isRecord(message)) return blocks;

    const seenImages = new Set<string>();

    // 1. Inline base64 image blocks produced by MessageQueue.
    const content = isRecord(message.message)
      ? message.message.content
      : undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "image") continue;
        const source = isRecord(block.source) ? block.source : undefined;
        if (!source || source.type !== "base64") continue;
        const data = typeof source.data === "string" ? source.data : undefined;
        if (!data) continue;
        const mimeType =
          typeof source.media_type === "string" && source.media_type
            ? source.media_type
            : "image/png";
        seenImages.add(data);
        blocks.push({ type: "image", mimeType, data });
      }
    }

    // 2. Uploaded attachments: images inline, everything else as a link.
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : [];
    for (const attachment of attachments) {
      if (!isRecord(attachment)) continue;
      const path = typeof attachment.path === "string" ? attachment.path : "";
      if (!path) continue;
      const mimeType =
        typeof attachment.mimeType === "string" ? attachment.mimeType : "";
      const name =
        (typeof attachment.originalName === "string"
          ? attachment.originalName
          : undefined) ??
        (typeof attachment.name === "string" ? attachment.name : undefined) ??
        basename(path);

      if (mimeType.startsWith("image/")) {
        try {
          const data = (await readFile(path)).toString("base64");
          if (seenImages.has(data)) continue;
          seenImages.add(data);
          blocks.push({ type: "image", mimeType, data });
          continue;
        } catch (err) {
          // Fall through to a resource_link so the path still reaches Kimi.
          this.log.warn(
            { err, path },
            "Failed to read image attachment for Kimi prompt",
          );
        }
      }

      blocks.push({
        type: "resource_link",
        uri: pathToFileURL(path).href,
        name,
        ...(mimeType ? { mimeType } : {}),
      });
    }

    return blocks;
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    const userMsg = message as { text?: string };
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

    const sdkMsg = message as { message?: { content?: string | unknown[] } };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (typeof block === "string") return block;
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            return (block as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  /**
   * Find the kimi CLI path.
   */
  private async findKimiPath(): Promise<string | null> {
    if (this.kimiPath && existsSync(this.kimiPath)) {
      return this.kimiPath;
    }

    const commonPaths = [
      join(KIMI_HOME, "bin", "kimi"),
      join(homedir(), ".local", "bin", "kimi"),
      "/usr/local/bin/kimi",
      join(homedir(), "bin", "kimi"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    try {
      const { stdout } = await execAsync(whichCommand("kimi"), {
        encoding: "utf-8",
      });
      const result = stdout.trim().split("\n")[0]?.trim();
      if (result && existsSync(result)) {
        return result;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }
}

/**
 * Default Kimi provider instance.
 */
export const kimiProvider = new KimiProvider();
