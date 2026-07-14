import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import {
  type ContextCumulativeUsage,
  type OpenCodeMessage,
  type OpenCodeSessionEntry,
  type OpenCodeStoredPart,
  type ProviderName,
  SESSION_TITLE_MAX_LENGTH,
  type SessionCreatedBy,
  type SessionQuestion,
  type UrlProjectId,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import {
  OPENCODE_DB_PATH,
  type OpenCodeDatabase,
  withOpenCodeDb,
} from "./opencode-db.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { createSessionQuestion } from "./user-questions.js";

/** Default OpenCode storage directory */
export const OPENCODE_STORAGE_DIR = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "storage",
);
const OPENCODE_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
const OPENCODE_CONFIG_PATH = process.env.OPENCODE_CONFIG;
const OPENCODE_CONFIG_CONTENT = process.env.OPENCODE_CONFIG_CONTENT;
const OPENCODE_DISABLE_PROJECT_CONFIG =
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1" ||
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "true";

/**
 * OpenCode storage directory structure:
 * ~/.local/share/opencode/storage/
 *   project/{projectId}.json        - Project metadata
 *   session/{projectId}/{sessionId}.json  - Session metadata
 *   message/{sessionId}/{messageId}.json  - Message metadata
 *   part/{messageId}/{partId}.json        - Message parts (text, tool-use, tool-result)
 */

export interface OpenCodeSessionReaderOptions {
  /** Base storage directory (e.g., ~/.local/share/opencode/storage) */
  storageDir?: string;
  /** Current sqlite database path (e.g., ~/.local/share/opencode/opencode.db) */
  dbPath?: string;
  /** Project path (used to look up the OpenCode project ID) */
  projectPath: string;
  /** Optional context window resolver (from ModelInfoService) */
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
}

/**
 * OpenCode JSON file schemas (simplified for reading)
 */
interface OpenCodeProjectJson {
  id: string;
  worktree: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

interface OpenCodeSessionJson {
  id: string;
  version?: string;
  projectID: string;
  directory?: string;
  title?: string;
  parentID?: string;
  model?: {
    id?: string;
    modelID?: string;
    providerID?: string;
    variant?: string;
  };
  time?: {
    created?: number;
    updated?: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

// Use OpenCodeMessage and OpenCodeStoredPart types from shared

interface OpenCodeConfigContextWindowCache {
  byProviderModel: Map<string, number>;
  byModel: Map<string, number>;
  ambiguousModels: Set<string>;
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const current = input[i] ?? "";
    const next = input[i + 1] ?? "";

    if (inLineComment) {
      if (current === "\n" || current === "\r") {
        inLineComment = false;
        output += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (current === '"' || current === "'") {
      inString = true;
      quote = current;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    output += current;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonLikeRecord(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stripJsonComments(input));
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function readOpenCodeConfigFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    return parseJsonLikeRecord(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function listOpenCodeProjectConfigFiles(projectPath: string): string[] {
  if (OPENCODE_DISABLE_PROJECT_CONFIG) return [];
  const dirs: string[] = [];
  let current = projectPath;
  const root = parsePath(current).root;

  while (current && current !== root) {
    dirs.push(current);
    current = dirname(current);
  }
  if (root) dirs.push(root);

  return dirs
    .reverse()
    .flatMap((dir) => [
      join(dir, "opencode.jsonc"),
      join(dir, "opencode.json"),
    ]);
}

function loadOpenCodeConfigContextWindows(
  projectPath: string,
): OpenCodeConfigContextWindowCache {
  const byProviderModel = new Map<string, number>();
  const byModelValues = new Map<string, Set<number>>();

  const ingest = (config: Record<string, unknown>) => {
    const providers = asRecord(config.providers) ?? asRecord(config.provider);
    if (!providers) return;

    for (const [providerId, providerValue] of Object.entries(providers)) {
      const models = asRecord(asRecord(providerValue)?.models);
      if (!models) continue;

      for (const [modelId, modelValue] of Object.entries(models)) {
        const context = asNumber(
          asRecord(asRecord(modelValue)?.limit)?.context,
        );
        if (!context || context <= 0) continue;

        byProviderModel.set(`${providerId}/${modelId}`, context);
        const values = byModelValues.get(modelId) ?? new Set<number>();
        values.add(context);
        byModelValues.set(modelId, values);
      }
    }
  };

  if (OPENCODE_CONFIG_CONTENT) {
    ingest(parseJsonLikeRecord(OPENCODE_CONFIG_CONTENT));
  }
  for (const filePath of [
    join(OPENCODE_CONFIG_DIR, "config.json"),
    join(OPENCODE_CONFIG_DIR, "opencode.json"),
    join(OPENCODE_CONFIG_DIR, "opencode.jsonc"),
    ...(OPENCODE_CONFIG_PATH ? [OPENCODE_CONFIG_PATH] : []),
    ...listOpenCodeProjectConfigFiles(projectPath),
  ]) {
    ingest(readOpenCodeConfigFile(filePath));
  }

  const byModel = new Map<string, number>();
  const ambiguousModels = new Set<string>();
  for (const [modelId, values] of byModelValues.entries()) {
    if (values.size === 1) {
      byModel.set(modelId, Array.from(values)[0] ?? 0);
    } else {
      ambiguousModels.add(modelId);
    }
  }

  return { byProviderModel, byModel, ambiguousModels };
}

function getOpenCodeConfigContextWindow(
  cache: OpenCodeConfigContextWindowCache,
  model: string | undefined,
): number | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash > 0 && slash < model.length - 1) {
    return cache.byProviderModel.get(model);
  }
  if (cache.ambiguousModels.has(model)) return undefined;
  return cache.byModel.get(model);
}

/**
 * Find the OpenCode project ID for a given project path by scanning project files.
 *
 * OpenCode uses an opaque hash as project ID. This function reads all project
 * JSON files and returns the ID whose worktree matches the given path.
 *
 * @param projectPath - The absolute path to the project directory
 * @param storageDir - The OpenCode storage directory (default: ~/.local/share/opencode/storage)
 * @returns The OpenCode project ID, or null if not found
 */
export async function findOpenCodeProjectId(
  projectPath: string,
  storageDir: string = OPENCODE_STORAGE_DIR,
): Promise<string | null> {
  const projectDir = join(storageDir, "project");

  try {
    const files = await readdir(projectDir);
    const jsonFiles = files.filter(
      (f) => f.endsWith(".json") && f !== "global.json",
    );

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(projectDir, file), "utf-8");
        const project = JSON.parse(content) as OpenCodeProjectJson;
        if (project.worktree === projectPath) {
          return project.id;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return null;
}

/**
 * OpenCode-specific session reader for OpenCode's file-based storage.
 *
 * OpenCode stores sessions in a directory structure rather than JSONL files:
 * - Project info in project/{id}.json
 * - Sessions in session/{projectId}/{sessionId}.json
 * - Messages in message/{sessionId}/{messageId}.json
 * - Parts (content) in part/{messageId}/{partId}.json
 */
class OpenCodeJsonSessionReader implements ISessionReader {
  private storageDir: string;
  private projectPath: string;
  private readonly getContextWindow?: OpenCodeSessionReaderOptions["getContextWindow"];
  private configContextWindows: OpenCodeConfigContextWindowCache | null = null;
  private openCodeProjectIdCache: string | null | undefined = undefined;

  constructor(options: OpenCodeSessionReaderOptions) {
    this.storageDir = options.storageDir ?? OPENCODE_STORAGE_DIR;
    this.projectPath = options.projectPath;
    this.getContextWindow = options.getContextWindow;
  }

  /**
   * Get the OpenCode project ID, looking it up lazily from storage.
   * Returns null if no OpenCode project exists for this path.
   */
  private async getOpenCodeProjectId(): Promise<string | null> {
    if (this.openCodeProjectIdCache !== undefined) {
      return this.openCodeProjectIdCache;
    }
    this.openCodeProjectIdCache = await findOpenCodeProjectId(
      this.projectPath,
      this.storageDir,
    );
    return this.openCodeProjectIdCache;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return [];
    }

    const summaries: SessionSummary[] = [];
    const sessionDir = join(this.storageDir, "session", openCodeProjectId);

    try {
      const files = await readdir(sessionDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        const sessionId = file.replace(".json", "");
        const summary = await this.getSessionSummary(sessionId, projectId);
        if (summary) {
          summaries.push(summary);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
      return [];
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return null;
    }

    const sessionPath = join(
      this.storageDir,
      "session",
      openCodeProjectId,
      `${sessionId}.json`,
    );

    try {
      const content = await readFile(sessionPath, "utf-8");
      const session = JSON.parse(content) as OpenCodeSessionJson;

      // Get message count and first user message for title
      const messageDir = join(this.storageDir, "message", sessionId);
      let messageCount = 0;
      let firstUserMessageText: string | null = null;
      const userQuestions: SessionQuestion[] = [];
      const sessionModelId = session.model?.id ?? session.model?.modelID;
      let model =
        sessionModelId && session.model?.providerID
          ? `${session.model.providerID}/${sessionModelId}`
          : sessionModelId;
      const sessionVariantKnown = Boolean(
        session.model && Object.hasOwn(session.model, "variant"),
      );
      let reasoningEffort = normalizeOpenCodeVariant(session.model?.variant);

      try {
        const messageFiles = await readdir(messageDir);
        const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));
        messageCount = jsonFiles.length;

        // Sort by filename (which contains timestamp) to get chronological order
        jsonFiles.sort();

        // Find first user message and model
        for (const file of jsonFiles) {
          const msgPath = join(messageDir, file);
          try {
            const msgContent = await readFile(msgPath, "utf-8");
            const msg = JSON.parse(msgContent) as OpenCodeMessage;

            // Get model from first assistant message
            if (!model && msg.role === "assistant") {
              model = getMessageModel(msg);
            }

            if (!sessionVariantKnown && msg.role === "user" && msg.model) {
              reasoningEffort = getMessageReasoningEffort(msg);
            }

            // Get first user message text
            if (msg.role === "user") {
              const text = await this.getMessageText(msg.id);
              if (text) {
                firstUserMessageText ??= text;
                const question = createSessionQuestion(
                  {
                    id: msg.id,
                    text,
                    timestamp: msg.time?.created
                      ? new Date(msg.time.created).toISOString()
                      : undefined,
                  },
                  `opencode-user-${userQuestions.length}`,
                );
                if (question) {
                  userQuestions.push(question);
                }
              }
            }
          } catch {
            // Skip unreadable messages
          }
        }
      } catch {
        // No messages yet
      }

      // Skip sessions with no messages
      if (messageCount === 0) {
        return null;
      }

      const stats = await stat(sessionPath);
      const contextUsage = await this.extractContextUsage(sessionId, model);

      // Use session title if available, otherwise first user message
      const fullTitle = session.title || firstUserMessageText?.trim() || null;

      return {
        id: sessionId,
        projectId,
        title: this.truncateTitle(fullTitle),
        fullTitle,
        createdAt: session.time?.created
          ? new Date(session.time.created).toISOString()
          : stats.birthtime.toISOString(),
        updatedAt: session.time?.updated
          ? new Date(session.time.updated).toISOString()
          : stats.mtime.toISOString(),
        messageCount,
        userQuestions,
        ownership: { owner: "none" }, // Will be updated by Supervisor
        contextUsage,
        provider: "opencode",
        model,
        reasoningEffort,
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const messages = await this.loadSessionMessages(sessionId, afterMessageId);

    return {
      summary,
      data: {
        provider: "opencode",
        session: {
          messages,
        },
      },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return null;
    }

    const sessionPath = join(
      this.storageDir,
      "session",
      openCodeProjectId,
      `${sessionId}.json`,
    );

    try {
      const stats = await stat(sessionPath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      // Otherwise parse the file and return { summary, mtime, size }
      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  /**
   * OpenCode doesn't have agent sessions like Claude's Task tool.
   * Return empty array.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * OpenCode doesn't have agent sessions like Claude's Task tool.
   * Return null.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  /**
   * Load all messages for a session, optionally after a specific message ID.
   */
  private async loadSessionMessages(
    sessionId: string,
    afterMessageId?: string,
  ): Promise<OpenCodeSessionEntry[]> {
    const messageDir = join(this.storageDir, "message", sessionId);
    const messages: OpenCodeSessionEntry[] = [];

    try {
      const messageFiles = await readdir(messageDir);
      const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));

      // Sort by filename to get chronological order
      jsonFiles.sort();

      let foundAfterMessage = !afterMessageId;

      for (const file of jsonFiles) {
        const messageId = file.replace(".json", "");

        // Skip messages until we find afterMessageId
        if (!foundAfterMessage) {
          if (messageId === afterMessageId) {
            foundAfterMessage = true;
          }
          continue;
        }

        const entry = await this.loadMessageEntry(messageDir, file);
        if (entry) {
          messages.push(entry);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }

    return messages;
  }

  /**
   * Load a single message with its parts as an OpenCodeSessionEntry.
   */
  private async loadMessageEntry(
    messageDir: string,
    file: string,
  ): Promise<OpenCodeSessionEntry | null> {
    try {
      const msgPath = join(messageDir, file);
      const content = await readFile(msgPath, "utf-8");
      const message = JSON.parse(content) as OpenCodeMessage;

      // Load parts for this message
      const parts = await this.loadMessageParts(message.id);

      return { message, parts };
    } catch {
      return null;
    }
  }

  /**
   * Load all parts for a message.
   */
  private async loadMessageParts(
    messageId: string,
  ): Promise<OpenCodeStoredPart[]> {
    const partDir = join(this.storageDir, "part", messageId);
    const parts: OpenCodeStoredPart[] = [];

    try {
      const partFiles = await readdir(partDir);
      const jsonFiles = partFiles.filter((f) => f.endsWith(".json"));

      // Sort by filename to get chronological order
      jsonFiles.sort();

      for (const file of jsonFiles) {
        try {
          const partPath = join(partDir, file);
          const content = await readFile(partPath, "utf-8");
          const part = JSON.parse(content) as OpenCodeStoredPart;
          parts.push(part);
        } catch {
          // Skip unreadable parts
        }
      }
    } catch {
      // No parts directory
    }

    return parts;
  }

  /**
   * Get the text content of a message by loading its parts.
   */
  private async getMessageText(messageId: string): Promise<string | null> {
    const parts = await this.loadMessageParts(messageId);

    for (const part of parts) {
      if (part.type === "text" && part.text) {
        return part.text;
      }
    }

    return null;
  }

  /**
   * Extract context usage from the last assistant message's tokens.
   *
   * @param sessionId - Session ID to extract usage from
   * @param model - Model ID for determining context window size
   */
  private async extractContextUsage(
    sessionId: string,
    model: string | undefined,
  ): Promise<ContextUsage | undefined> {
    const messageDir = join(this.storageDir, "message", sessionId);

    try {
      const messageFiles = await readdir(messageDir);
      const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));

      // Sort and reverse to get most recent first
      jsonFiles.sort().reverse();

      for (const file of jsonFiles) {
        try {
          const msgPath = join(messageDir, file);
          const content = await readFile(msgPath, "utf-8");
          const msg = JSON.parse(content) as OpenCodeMessage;

          if (msg.role === "assistant" && msg.tokens) {
            const effectiveModel = getMessageModel(msg) ?? model;
            const inputTokens =
              (msg.tokens.input ?? 0) +
              (msg.tokens.cache?.read ?? 0) +
              (msg.tokens.cache?.write ?? 0);

            if (inputTokens === 0) continue;

            const contextWindowSize = this.resolveContextWindow(
              effectiveModel,
              sessionId,
            );
            const percentage = Math.round(
              (inputTokens / contextWindowSize) * 100,
            );

            const result: ContextUsage = {
              inputTokens,
              percentage,
              contextWindow: contextWindowSize,
            };

            if (msg.tokens.output !== undefined && msg.tokens.output > 0) {
              result.outputTokens = msg.tokens.output;
            }
            if (
              msg.tokens.cache?.read !== undefined &&
              msg.tokens.cache.read > 0
            ) {
              result.cacheReadTokens = msg.tokens.cache.read;
            }
            if (
              msg.tokens.cache?.write !== undefined &&
              msg.tokens.cache.write > 0
            ) {
              result.cacheCreationTokens = msg.tokens.cache.write;
            }

            return result;
          }
        } catch {
          // Skip unreadable messages
        }
      }
    } catch {
      // No messages
    }

    return undefined;
  }

  private resolveContextWindow(
    model: string | undefined,
    sessionId: string,
  ): number {
    return (
      this.getContextWindow?.(model, "opencode", sessionId) ??
      getOpenCodeConfigContextWindow(this.getConfigContextWindows(), model) ??
      getModelContextWindow(model, "opencode")
    );
  }

  private getConfigContextWindows(): OpenCodeConfigContextWindowCache {
    this.configContextWindows ??= loadOpenCodeConfigContextWindows(
      this.projectPath,
    );
    return this.configContextWindows;
  }

  /**
   * Truncate title to max length.
   */
  private truncateTitle(title: string | null): string | null {
    if (!title) return null;
    const trimmed = title.trim();
    if (trimmed.length <= SESSION_TITLE_MAX_LENGTH) return trimmed;
    return `${trimmed.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
  }
}

interface OpenCodeSqliteSessionRow {
  id: string;
  projectId: string;
  parentId: string | null;
  directory: string;
  title: string | null;
  model: string | null;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
}

interface OpenCodeSqliteSessionStats {
  sessionId: string;
  mtime: number;
  size: number;
  messageCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

interface ParsedOpenCodeModel {
  model?: string;
  reasoningEffort?: string;
  variantKnown: boolean;
}

function normalizeOpenCodeVariant(variant: string | undefined) {
  const normalized = variant?.trim();
  return normalized || undefined;
}

function parseOpenCodeModel(
  model: string | null | undefined,
): ParsedOpenCodeModel {
  if (!model) return { variantKnown: false };
  const trimmed = model.trim();
  if (!trimmed) return { variantKnown: false };

  const parsed = parseJsonRecord(trimmed);
  const modelId = asString(parsed.id) ?? asString(parsed.modelID);
  const providerId = asString(parsed.providerID);
  const variant = asString(parsed.variant);
  const parsedModel =
    modelId && providerId ? `${providerId}/${modelId}` : modelId;
  if (parsedModel) {
    return {
      model: parsedModel,
      reasoningEffort: normalizeOpenCodeVariant(variant),
      variantKnown: Object.hasOwn(parsed, "variant"),
    };
  }

  return { model: trimmed, variantKnown: false };
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return asRecord(record[key]);
}

function getNestedNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  return asNumber(record[key]);
}

function truncateOpenCodeTitle(title: string | null): string | null {
  if (!title) return null;
  const trimmed = title.trim();
  if (trimmed.length <= SESSION_TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}

function isGenericOpenCodeTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const normalized = title.trim().toLowerCase();
  return normalized === "yep anywhere session" || normalized === "new session";
}

function mapSqliteSessionRow(
  row: Record<string, unknown> | undefined,
): OpenCodeSqliteSessionRow | null {
  if (!row) return null;
  const id = asString(row.id);
  const projectId = asString(row.project_id) ?? "global";
  const parentId = asString(row.parent_id) ?? null;
  const directory = asString(row.directory);
  const createdAtMs = asNumber(row.time_created);
  const updatedAtMs = asNumber(row.time_updated);
  if (
    !id ||
    !directory ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    return null;
  }

  return {
    id,
    projectId,
    parentId,
    directory,
    title: asString(row.title) ?? null,
    model: asString(row.model) ?? null,
    metadata: asRecord(row.metadata) ?? parseJsonRecord(row.metadata),
    createdAtMs,
    updatedAtMs,
    tokensInput: asNumber(row.tokens_input) ?? 0,
    tokensOutput: asNumber(row.tokens_output) ?? 0,
    tokensCacheRead: asNumber(row.tokens_cache_read) ?? 0,
    tokensCacheWrite: asNumber(row.tokens_cache_write) ?? 0,
    tokensReasoning: asNumber(row.tokens_reasoning) ?? 0,
  };
}

function messageFromSqliteRow(
  row: Record<string, unknown>,
): OpenCodeMessage | null {
  const id = asString(row.id);
  const sessionID = asString(row.session_id);
  const createdAtMs = asNumber(row.time_created);
  const updatedAtMs = asNumber(row.time_updated);
  if (!id || !sessionID) return null;

  const data = parseJsonRecord(row.data);
  const role =
    data.role === "user" || data.role === "assistant" ? data.role : null;
  if (!role) return null;

  const time = getNestedRecord(data, "time") ?? {};
  const model = getNestedRecord(data, "model") ?? {};
  const modelID =
    asString(data.modelID) ?? asString(model.modelID) ?? asString(model.id);
  const providerID = asString(data.providerID) ?? asString(model.providerID);

  return {
    ...data,
    id,
    sessionID,
    role,
    time: {
      ...time,
      created: getNestedNumber(time, "created") ?? createdAtMs,
      completed: getNestedNumber(time, "completed") ?? updatedAtMs,
    },
    ...(modelID ? { modelID } : {}),
    ...(providerID ? { providerID } : {}),
  } as OpenCodeMessage;
}

function partFromSqliteRow(
  row: Record<string, unknown>,
): OpenCodeStoredPart | null {
  const id = asString(row.id);
  const messageID = asString(row.message_id);
  const sessionID = asString(row.session_id);
  if (!id || !messageID || !sessionID) return null;

  const data = parseJsonRecord(row.data);
  const type = asString(data.type);
  if (!type) return null;

  return {
    ...data,
    id,
    messageID,
    sessionID,
    type,
  } as OpenCodeStoredPart;
}

function extractMessageText(parts: OpenCodeStoredPart[]): string | null {
  const text = parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("");
  return text.trim() ? text : null;
}

function computeCumulativeUsage(
  row: OpenCodeSqliteSessionRow,
  assistantTurnCount: number,
): ContextCumulativeUsage | undefined {
  const totalTokens =
    row.tokensInput +
    row.tokensOutput +
    row.tokensReasoning +
    row.tokensCacheRead +
    row.tokensCacheWrite;
  if (totalTokens <= 0 && assistantTurnCount <= 0) return undefined;

  return {
    totalTokens,
    inputTokens: row.tokensInput,
    outputTokens: row.tokensOutput,
    cacheReadTokens: row.tokensCacheRead,
    cacheCreationTokens: row.tokensCacheWrite,
    turnCount: assistantTurnCount,
  };
}

function getMessageModel(message: OpenCodeMessage): string | undefined {
  const modelId =
    message.modelID ?? message.model?.modelID ?? message.model?.id;
  const providerId = message.providerID ?? message.model?.providerID;
  if (providerId && modelId) {
    return `${providerId}/${modelId}`;
  }
  return modelId;
}

function getMessageReasoningEffort(
  message: OpenCodeMessage,
): string | undefined {
  return normalizeOpenCodeVariant(message.model?.variant) ?? "default";
}

function normalizeMetadataString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function deriveOpenCodeCreatedByFromMetadata(
  metadata: Record<string, unknown>,
): SessionCreatedBy | undefined {
  const createdBy = normalizeMetadataString(metadata.createdBy);
  if (createdBy === "yep") return "yep";
  if (createdBy === "external") return "external";

  const source = normalizeMetadataString(metadata.source);
  const client = normalizeMetadataString(metadata.client);
  const originator = normalizeMetadataString(metadata.originator);
  if (
    source === "yep-anywhere" ||
    client === "yep-anywhere" ||
    originator === "yep-anywhere"
  ) {
    return "yep";
  }

  return undefined;
}

const SESSION_STATS_SQL = `
  WITH message_stats AS (
    SELECT
      session_id,
      COUNT(*) AS message_count,
      MAX(time_updated) AS message_updated,
      SUM(LENGTH(data)) AS message_bytes
    FROM message
    GROUP BY session_id
  ),
  part_stats AS (
    SELECT
      session_id,
      COUNT(*) AS part_count,
      MAX(time_updated) AS part_updated,
      SUM(LENGTH(data)) AS part_bytes
    FROM part
    GROUP BY session_id
  )
  SELECT
    s.id,
    MAX(
      s.time_updated,
      COALESCE(message_stats.message_updated, 0),
      COALESCE(part_stats.part_updated, 0)
    ) AS mtime,
    COALESCE(message_stats.message_count, 0) AS message_count,
    COALESCE(part_stats.part_count, 0) AS part_count,
    LENGTH(COALESCE(s.title, '')) +
      LENGTH(COALESCE(s.model, '')) +
      COALESCE(message_stats.message_bytes, 0) +
      COALESCE(part_stats.part_bytes, 0) AS indexed_size
  FROM session s
  LEFT JOIN message_stats ON message_stats.session_id = s.id
  LEFT JOIN part_stats ON part_stats.session_id = s.id
`;

export class OpenCodeSessionReader implements ISessionReader {
  private readonly dbPath: string;
  private readonly projectPath: string;
  private readonly getContextWindow?: OpenCodeSessionReaderOptions["getContextWindow"];
  private configContextWindows: OpenCodeConfigContextWindowCache | null = null;
  private readonly legacyReader: ISessionReader;

  constructor(options: OpenCodeSessionReaderOptions) {
    this.dbPath = options.dbPath ?? OPENCODE_DB_PATH;
    this.projectPath = canonicalizeProjectPath(options.projectPath);
    this.getContextWindow = options.getContextWindow;
    this.legacyReader = new OpenCodeJsonSessionReader(options);
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const sqliteSessions = await this.listSqliteSessions(projectId);
    if (sqliteSessions !== undefined) return sqliteSessions;
    return this.legacyReader.listSessions(projectId);
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sqliteSummary = await this.getSqliteSessionSummary(
      sessionId,
      projectId,
    );
    if (sqliteSummary) return sqliteSummary;
    return this.legacyReader.getSessionSummary(sessionId, projectId);
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const summary = await this.getSqliteSessionSummary(sessionId, projectId);
    if (summary) {
      return {
        summary,
        data: {
          provider: "opencode",
          session: {
            messages: await this.loadSqliteSessionMessages(
              sessionId,
              afterMessageId,
            ),
          },
        },
      };
    }

    return this.legacyReader.getSession(
      sessionId,
      projectId,
      afterMessageId,
      options,
    );
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sqliteStats = await this.getSqliteSessionStats(sessionId);
    if (sqliteStats) {
      if (
        sqliteStats.mtime === cachedMtime &&
        sqliteStats.size === cachedSize
      ) {
        return null;
      }
      const summary = await this.getSqliteSessionSummary(sessionId, projectId);
      return summary
        ? { summary, mtime: sqliteStats.mtime, size: sqliteStats.size }
        : null;
    }

    return this.legacyReader.getSessionSummaryIfChanged(
      sessionId,
      projectId,
      cachedMtime,
      cachedSize,
    );
  }

  getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return Promise.resolve([]);
  }

  getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return Promise.resolve(null);
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const stats = await this.getSqliteSessionStats(sessionId);
    if (stats) return this.dbPath;
    return this.legacyReader.getSessionFilePath?.(sessionId) ?? null;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const stats = await this.listSqliteSessionStats();
    return (
      stats?.map((entry) => ({
        sessionId: entry.sessionId,
        filePath: this.dbPath,
        mtime: entry.mtime,
        size: entry.size,
      })) ?? []
    );
  }

  getIndexScopeKey(_sessionDir: string): string {
    return `opencode::${this.dbPath}::${this.projectPath}`;
  }

  private async listSqliteSessions(
    projectId: UrlProjectId,
  ): Promise<SessionSummary[] | undefined> {
    return withOpenCodeDb<SessionSummary[] | undefined>(
      this.dbPath,
      undefined,
      (db) => {
        const rows = db
          .prepare(
            `
              SELECT id
              FROM session
              WHERE directory = ? AND time_archived IS NULL
              ORDER BY time_updated DESC
            `,
          )
          .all(this.projectPath);

        const summaries: SessionSummary[] = [];
        for (const row of rows) {
          const sessionId = asString(row.id);
          if (!sessionId) continue;
          const summary = this.getSqliteSessionSummaryFromDb(
            db,
            sessionId,
            projectId,
          );
          if (summary) summaries.push(summary);
        }

        summaries.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        return summaries;
      },
    );
  }

  private async getSqliteSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null | undefined> {
    return withOpenCodeDb<SessionSummary | null | undefined>(
      this.dbPath,
      undefined,
      (db) => this.getSqliteSessionSummaryFromDb(db, sessionId, projectId),
    );
  }

  private getSqliteSessionSummaryFromDb(
    db: OpenCodeDatabase,
    sessionId: string,
    projectId: UrlProjectId,
  ): SessionSummary | null {
    const row = mapSqliteSessionRow(
      db
        .prepare(
          `
            SELECT
              id,
              project_id,
              parent_id,
              directory,
              title,
              model,
              metadata,
              time_created,
              time_updated,
              tokens_input,
              tokens_output,
              tokens_reasoning,
              tokens_cache_read,
              tokens_cache_write
            FROM session
            WHERE id = ? AND directory = ? AND time_archived IS NULL
          `,
        )
        .get(sessionId, this.projectPath),
    );
    if (!row) return null;

    const messages = this.loadSqliteMessagesFromDb(db, sessionId);
    if (messages.length === 0) return null;

    let firstUserMessageText: string | null = null;
    const userQuestions: SessionQuestion[] = [];
    const parsedModel = parseOpenCodeModel(row.model);
    let model = parsedModel.model;
    let reasoningEffort = parsedModel.reasoningEffort;
    let assistantTurnCount = 0;

    for (const message of messages) {
      if (message.role === "assistant") {
        assistantTurnCount++;
        model ??= getMessageModel(message);
        continue;
      }

      if (message.role !== "user") continue;
      if (!parsedModel.variantKnown && message.model) {
        reasoningEffort = getMessageReasoningEffort(message);
      }
      const text = this.getSqliteMessageTextFromDb(db, message.id);
      if (!text) continue;

      firstUserMessageText ??= text;
      const question = createSessionQuestion(
        {
          id: message.id,
          text,
          timestamp: message.time?.created
            ? new Date(message.time.created).toISOString()
            : undefined,
        },
        `opencode-user-${userQuestions.length}`,
      );
      if (question) userQuestions.push(question);
    }

    const nonGenericTitle = isGenericOpenCodeTitle(row.title)
      ? null
      : row.title?.trim() || null;
    // OpenCode replaces its generic initial title with a generated session
    // title. Prefer that persisted title so the SQLite reader agrees with the
    // bridge and does not flip back to the first user prompt on each refresh.
    const fullTitle = nonGenericTitle || firstUserMessageText?.trim() || null;
    const contextUsage = this.extractSqliteContextUsageFromMessages(
      messages,
      model,
      sessionId,
    );
    const createdBy =
      deriveOpenCodeCreatedByFromMetadata(row.metadata) ??
      this.getParentSqliteCreatedByFromDb(db, row.parentId);

    return {
      id: sessionId,
      projectId,
      title: truncateOpenCodeTitle(fullTitle),
      fullTitle,
      createdAt: new Date(row.createdAtMs).toISOString(),
      updatedAt: new Date(row.updatedAtMs).toISOString(),
      messageCount: messages.length,
      userQuestions,
      ownership: { owner: "none" },
      contextUsage,
      cumulativeUsage: computeCumulativeUsage(row, assistantTurnCount),
      provider: "opencode",
      model,
      reasoningEffort,
      createdBy,
    };
  }

  private getParentSqliteCreatedByFromDb(
    db: OpenCodeDatabase,
    parentId: string | null,
  ): SessionCreatedBy | undefined {
    if (!parentId) return undefined;
    const parent = mapSqliteSessionRow(
      db
        .prepare(
          `
            SELECT
              id,
              project_id,
              parent_id,
              directory,
              title,
              model,
              metadata,
              time_created,
              time_updated,
              tokens_input,
              tokens_output,
              tokens_reasoning,
              tokens_cache_read,
              tokens_cache_write
            FROM session
            WHERE id = ?
          `,
        )
        .get(parentId),
    );
    if (!parent) return undefined;
    return deriveOpenCodeCreatedByFromMetadata(parent.metadata);
  }

  private async loadSqliteSessionMessages(
    sessionId: string,
    afterMessageId?: string,
  ): Promise<OpenCodeSessionEntry[]> {
    return withOpenCodeDb(this.dbPath, [], (db) => {
      const messages = this.loadSqliteMessagesFromDb(db, sessionId);
      const entries: OpenCodeSessionEntry[] = [];
      let foundAfterMessage = !afterMessageId;

      for (const message of messages) {
        if (!foundAfterMessage) {
          if (message.id === afterMessageId) {
            foundAfterMessage = true;
          }
          continue;
        }

        entries.push({
          message,
          parts: this.loadSqliteMessagePartsFromDb(db, message.id),
        });
      }

      return entries;
    });
  }

  private loadSqliteMessagesFromDb(
    db: OpenCodeDatabase,
    sessionId: string,
  ): OpenCodeMessage[] {
    return db
      .prepare(
        `
          SELECT id, session_id, time_created, time_updated, data
          FROM message
          WHERE session_id = ?
          ORDER BY time_created ASC, id ASC
        `,
      )
      .all(sessionId)
      .map(messageFromSqliteRow)
      .filter((message): message is OpenCodeMessage => message !== null);
  }

  private loadSqliteMessagePartsFromDb(
    db: OpenCodeDatabase,
    messageId: string,
  ): OpenCodeStoredPart[] {
    return db
      .prepare(
        `
          SELECT id, message_id, session_id, time_created, time_updated, data
          FROM part
          WHERE message_id = ?
          ORDER BY time_created ASC, id ASC
        `,
      )
      .all(messageId)
      .map(partFromSqliteRow)
      .filter((part): part is OpenCodeStoredPart => part !== null);
  }

  private getSqliteMessageTextFromDb(
    db: OpenCodeDatabase,
    messageId: string,
  ): string | null {
    return extractMessageText(this.loadSqliteMessagePartsFromDb(db, messageId));
  }

  private extractSqliteContextUsageFromMessages(
    messages: OpenCodeMessage[],
    model: string | undefined,
    sessionId?: string,
  ): ContextUsage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message || message.role !== "assistant" || !message.tokens) continue;

      const inputTokens =
        (message.tokens.input ?? 0) +
        (message.tokens.cache?.read ?? 0) +
        (message.tokens.cache?.write ?? 0);
      if (inputTokens === 0) continue;

      const effectiveModel = getMessageModel(message) ?? model;
      const contextWindowSize = this.resolveContextWindow(
        effectiveModel,
        sessionId ?? message.sessionID,
      );
      const usage: ContextUsage = {
        inputTokens,
        percentage: Math.round((inputTokens / contextWindowSize) * 100),
        contextWindow: contextWindowSize,
      };
      if (message.tokens.output !== undefined && message.tokens.output > 0) {
        usage.outputTokens = message.tokens.output;
      }
      if (
        message.tokens.cache?.read !== undefined &&
        message.tokens.cache.read > 0
      ) {
        usage.cacheReadTokens = message.tokens.cache.read;
      }
      if (
        message.tokens.cache?.write !== undefined &&
        message.tokens.cache.write > 0
      ) {
        usage.cacheCreationTokens = message.tokens.cache.write;
      }
      return usage;
    }

    return undefined;
  }

  private resolveContextWindow(
    model: string | undefined,
    sessionId: string | undefined,
  ): number {
    return (
      this.getContextWindow?.(model, "opencode", sessionId) ??
      getOpenCodeConfigContextWindow(this.getConfigContextWindows(), model) ??
      getModelContextWindow(model, "opencode")
    );
  }

  private getConfigContextWindows(): OpenCodeConfigContextWindowCache {
    this.configContextWindows ??= loadOpenCodeConfigContextWindows(
      this.projectPath,
    );
    return this.configContextWindows;
  }

  private async listSqliteSessionStats(): Promise<
    OpenCodeSqliteSessionStats[] | undefined
  > {
    return withOpenCodeDb<OpenCodeSqliteSessionStats[] | undefined>(
      this.dbPath,
      undefined,
      (db) => {
        const rows = db
          .prepare(
            `
              ${SESSION_STATS_SQL}
              WHERE s.directory = ? AND s.time_archived IS NULL
              ORDER BY mtime DESC
            `,
          )
          .all(this.projectPath);

        return rows
          .map((row) => this.mapStatsRow(row))
          .filter(
            (stats): stats is OpenCodeSqliteSessionStats => stats !== null,
          );
      },
    );
  }

  private async getSqliteSessionStats(
    sessionId: string,
  ): Promise<OpenCodeSqliteSessionStats | null | undefined> {
    return withOpenCodeDb<OpenCodeSqliteSessionStats | null | undefined>(
      this.dbPath,
      undefined,
      (db) =>
        this.mapStatsRow(
          db
            .prepare(
              `
                ${SESSION_STATS_SQL}
                WHERE s.id = ? AND s.directory = ? AND s.time_archived IS NULL
              `,
            )
            .get(sessionId, this.projectPath),
        ),
    );
  }

  private mapStatsRow(
    row: Record<string, unknown> | undefined,
  ): OpenCodeSqliteSessionStats | null {
    if (!row) return null;
    const sessionId = asString(row.id);
    const mtime = asNumber(row.mtime);
    const size = asNumber(row.indexed_size);
    const messageCount = asNumber(row.message_count) ?? 0;
    if (!sessionId || mtime === undefined || size === undefined) return null;
    return {
      sessionId,
      mtime,
      size,
      messageCount,
    };
  }
}
