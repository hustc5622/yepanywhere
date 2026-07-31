/**
 * KimiSessionReader - Reads Kimi Code CLI sessions from disk.
 *
 * Kimi stores sessions under
 *   ~/.kimi-code/sessions/<workspace>/session_<uuid>/
 *     ├── state.json               (title / timestamps / workDir)
 *     └── agents/main/wire.jsonl   (append-only event log)
 *
 * The session id is the `session_<uuid>` directory name. Sessions are linear
 * (no DAG). The transcript is reconstructed from the wire.jsonl records by the
 * normalization layer; this reader is responsible for discovery, filtering by
 * project cwd, and summary metadata.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ContextCumulativeUsage,
  type KimiStepEndEvent,
  type KimiToolCallEvent,
  type KimiToolResultEvent,
  type KimiWireRecord,
  SESSION_TITLE_MAX_LENGTH,
  type SessionQuestion,
  type UrlProjectId,
  getKimiPromptText,
  getModelContextWindow,
  isKimiLoopEventRecord,
  isKimiModelConfigRecord,
  isKimiTurnPromptRecord,
  parseKimiSessionState,
  parseKimiWireJsonl,
} from "@yep-anywhere/shared";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import { convertKimiMessages } from "./normalization.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { createSessionQuestion } from "./user-questions.js";

export interface KimiSessionReaderOptions {
  /** Base directory for Kimi sessions (~/.kimi-code/sessions). */
  sessionsDir: string;
  /** Project cwd to filter sessions by (matched against state.json workDir). */
  projectPath?: string;
}

interface KimiSessionCacheEntry {
  id: string;
  /** Path to agents/main/wire.jsonl */
  filePath: string;
  sessionDir: string;
  workDir?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  mtime: number;
  size: number;
}

/** Aggregate derived from a parsed wire.jsonl. */
interface KimiWireDerived {
  records: KimiWireRecord[];
  model: string | undefined;
  messageCount: number;
  contextUsage: ContextUsage | undefined;
  cumulativeUsage: ContextCumulativeUsage | undefined;
  firstPromptText: string | undefined;
}

export class KimiSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;

  private sessionFileCache: Map<string, KimiSessionCacheEntry> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(options: KimiSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();

    for (const session of sessions) {
      if (this.projectPath && session.workDir !== this.projectPath) {
        continue;
      }
      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) summaries.push(summary);
    }

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
    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    try {
      const content = await readFile(entry.filePath, "utf-8");
      const derived = this.deriveFromWire(content);
      if (derived.messageCount === 0) return null;

      const stats = await stat(entry.filePath);
      const fullTitle = (
        entry.title && entry.title !== "New Session"
          ? entry.title
          : (derived.firstPromptText ?? entry.title ?? "")
      ).trim();
      const title =
        fullTitle.length === 0
          ? null
          : fullTitle.length <= SESSION_TITLE_MAX_LENGTH
            ? fullTitle
            : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;

      return {
        id: sessionId,
        projectId,
        title,
        fullTitle: fullTitle.length === 0 ? null : fullTitle,
        createdAt: entry.createdAt ?? stats.birthtime.toISOString(),
        updatedAt: entry.updatedAt ?? stats.mtime.toISOString(),
        messageCount: derived.messageCount,
        userQuestions: this.extractUserQuestions(derived.records, sessionId),
        ownership: { owner: "none" },
        contextUsage: derived.contextUsage,
        cumulativeUsage: derived.cumulativeUsage,
        provider: "kimi",
        model: derived.model,
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

    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    const content = await readFile(entry.filePath, "utf-8");
    const records = parseKimiWireJsonl(content);

    return {
      summary,
      data: {
        provider: "kimi",
        session: {
          sessionId,
          workDir: entry.workDir,
          title: entry.title,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          model: summary.model,
          // Sibling of wire.jsonl; holds the content-addressed image bytes
          // referenced by `blobref:` prompt parts.
          blobsDir: join(dirname(entry.filePath), "blobs"),
          records,
        },
      },
      // afterMessageId incremental fetch is not supported for Kimi (message
      // ids are synthesized during normalization). Callers fall back to full
      // fetch; kept in the signature for interface parity.
      ...(afterMessageId ? {} : {}),
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    try {
      const stats = await stat(entry.filePath);
      if (stats.mtimeMs === cachedMtime && stats.size === cachedSize) {
        return null;
      }
      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;
      return { summary, mtime: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }

  /**
   * Map subagent-spawning tool calls in the main wire to their subagent ids.
   *
   * Kimi runs `Agent` / `AgentSwarm` subagents whose transcripts live in
   * sibling `agents/<agentId>/wire.jsonl` files. The parent tool.result output
   * carries the produced agent id(s): `agent_id: agent-0` for a single Agent,
   * or `<subagent agent_id="agent-0" ...>` entries for an AgentSwarm.
   *
   * Kimi agent ids (`agent-0`, `agent-1`, ...) are only unique within a
   * session, so this must be scoped by sessionId — the route forwards it.
   */
  async getAgentMappings(
    sessionId?: string,
  ): Promise<{ toolUseId: string; agentId: string }[]> {
    if (!sessionId) return [];
    const entry = await this.findSessionFile(sessionId);
    if (!entry) return [];

    let records: KimiWireRecord[];
    try {
      records = parseKimiWireJsonl(await readFile(entry.filePath, "utf-8"));
    } catch {
      return [];
    }

    // Collect subagent-spawning tool calls and pair them with their results.
    const spawnCallIds = new Set<string>();
    const resultOutputByCallId = new Map<string, string>();
    for (const record of records) {
      if (!isKimiLoopEventRecord(record)) continue;
      const event = record.event;
      if (event.type === "tool.call") {
        const call = event as KimiToolCallEvent;
        if (call.name === "Agent" || call.name === "AgentSwarm") {
          spawnCallIds.add(call.toolCallId);
        }
      } else if (event.type === "tool.result") {
        const res = event as KimiToolResultEvent;
        const output = res.result?.output;
        if (typeof output === "string" && res.toolCallId) {
          resultOutputByCallId.set(res.toolCallId, output);
        }
      }
    }

    const mappings: { toolUseId: string; agentId: string }[] = [];
    for (const toolUseId of spawnCallIds) {
      const output = resultOutputByCallId.get(toolUseId);
      if (!output) continue;
      const agentIds = parseKimiSubagentIds(output);
      // The client maps toolUseId -> agentId 1:1; use the first produced
      // subagent. Full AgentSwarm fan-out (N subagents per call) is future
      // work that needs a dedicated multi-agent renderer.
      if (agentIds.length > 0) {
        mappings.push({ toolUseId, agentId: agentIds[0] as string });
      }
    }
    return mappings;
  }

  /**
   * Load a subagent transcript from `agents/<agentId>/wire.jsonl`.
   *
   * agentId (e.g. `agent-0`) is only unique within a session, so sessionId is
   * required to locate the owning session directory.
   */
  async getAgentSession(
    agentId: string,
    sessionId?: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    if (!sessionId) return null;
    // Guard against path traversal: agent ids are simple slugs.
    if (!/^[\w.-]+$/.test(agentId) || agentId.includes("..")) return null;

    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    const agentDir = join(entry.sessionDir, "agents", agentId);
    const wirePath = join(agentDir, "wire.jsonl");

    let records: KimiWireRecord[];
    try {
      records = parseKimiWireJsonl(await readFile(wirePath, "utf-8"));
    } catch {
      return null;
    }

    const messages = convertKimiMessages({
      sessionId: `${sessionId}/${agentId}`,
      blobsDir: join(agentDir, "blobs"),
      records,
    });

    return { messages, status: inferKimiAgentStatus(records, messages) };
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const entry = await this.findSessionFile(sessionId);
    return entry?.filePath ?? null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `kimi::${sessionDir}::${this.projectPath ?? "*"}`;
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const sessions = await this.scanSessions();
    const results: SessionFileEntry[] = [];
    for (const session of sessions) {
      if (this.projectPath && session.workDir !== this.projectPath) continue;
      results.push({
        sessionId: session.id,
        filePath: session.filePath,
        mtime: session.mtime,
        size: session.size,
      });
    }
    return results;
  }

  /**
   * Scan the sessions root for `<workspace>/session_<uuid>` directories.
   */
  private async scanSessions(): Promise<KimiSessionCacheEntry[]> {
    if (Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return Array.from(this.sessionFileCache.values());
    }

    const sessions: KimiSessionCacheEntry[] = [];
    this.sessionFileCache.clear();

    let workspaceDirs: string[];
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      workspaceDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(this.sessionsDir, e.name));
    } catch {
      return [];
    }

    for (const workspaceDir of workspaceDirs) {
      let sessionDirs: string[];
      try {
        const entries = await readdir(workspaceDir, { withFileTypes: true });
        sessionDirs = entries
          .filter((e) => e.isDirectory() && e.name.startsWith("session_"))
          .map((e) => e.name);
      } catch {
        continue;
      }

      for (const sessionName of sessionDirs) {
        const sessionDir = join(workspaceDir, sessionName);
        const entry = await this.readSessionMeta(sessionName, sessionDir);
        if (entry) {
          sessions.push(entry);
          this.sessionFileCache.set(entry.id, entry);
        }
      }
    }

    this.cacheTimestamp = Date.now();
    return sessions;
  }

  private async readSessionMeta(
    sessionId: string,
    sessionDir: string,
  ): Promise<KimiSessionCacheEntry | null> {
    const filePath = join(sessionDir, "agents", "main", "wire.jsonl");
    try {
      const stats = await stat(filePath);
      let workDir: string | undefined;
      let title: string | undefined;
      let createdAt: string | undefined;
      let updatedAt: string | undefined;

      try {
        const stateRaw = await readFile(
          join(sessionDir, "state.json"),
          "utf-8",
        );
        const state = parseKimiSessionState(stateRaw);
        if (state) {
          workDir = state.workDir;
          title = state.title;
          createdAt = state.createdAt;
          updatedAt = state.updatedAt;
        }
      } catch {
        // state.json missing/unreadable — fall back to file stats below.
      }

      return {
        id: sessionId,
        filePath,
        sessionDir,
        workDir,
        title,
        createdAt,
        updatedAt,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      // No wire.jsonl — not a usable session.
      return null;
    }
  }

  private async findSessionFile(
    sessionId: string,
  ): Promise<KimiSessionCacheEntry | null> {
    const cached = this.sessionFileCache.get(sessionId);
    if (cached) return cached;
    await this.scanSessions();
    return this.sessionFileCache.get(sessionId) ?? null;
  }

  /**
   * Derive summary aggregates from a wire.jsonl body without building the full
   * normalized message list. Message counting mirrors the normalization rule:
   * user turns come from `turn.prompt`; assistant messages are flushed at each
   * tool.result / turn boundary; tool results are individual messages.
   */
  private deriveFromWire(content: string): KimiWireDerived {
    const records = parseKimiWireJsonl(content);

    let model: string | undefined;
    let firstPromptText: string | undefined;
    let messageCount = 0;
    let turnCount = 0;

    // Assistant-segment tracking (mirrors convertKimiMessages flush points).
    let pendingAssistantBlocks = 0;
    const flushAssistant = () => {
      if (pendingAssistantBlocks > 0) {
        messageCount += 1;
        pendingAssistantBlocks = 0;
      }
    };

    // Cumulative usage accumulators.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let lastContextInput: number | undefined;

    for (const record of records) {
      if (isKimiModelConfigRecord(record)) {
        model = record.modelAlias;
        continue;
      }
      if (isKimiTurnPromptRecord(record)) {
        flushAssistant();
        messageCount += 1;
        turnCount += 1;
        if (firstPromptText === undefined) {
          firstPromptText = getKimiPromptText(record.input);
        }
        continue;
      }
      if (!isKimiLoopEventRecord(record)) continue;

      const event = record.event;
      switch (event.type) {
        case "content.part":
        case "tool.call":
          pendingAssistantBlocks += 1;
          break;
        case "tool.result":
          flushAssistant();
          messageCount += 1;
          break;
        case "step.end": {
          const usage = (event as KimiStepEndEvent).usage;
          if (usage) {
            const other = usage.inputOther ?? 0;
            const cacheRead = usage.inputCacheRead ?? 0;
            const cacheCreation = usage.inputCacheCreation ?? 0;
            inputTokens += other;
            outputTokens += usage.output ?? 0;
            cacheReadTokens += cacheRead;
            cacheCreationTokens += cacheCreation;
            lastContextInput = other + cacheRead + cacheCreation;
          }
          break;
        }
        default:
          break;
      }
    }
    flushAssistant();

    const contextWindow = getModelContextWindow(model, "kimi");
    const contextUsage: ContextUsage | undefined =
      lastContextInput !== undefined
        ? {
            inputTokens: lastContextInput,
            percentage: Math.round((lastContextInput / contextWindow) * 100),
            contextWindow,
          }
        : undefined;

    const cumulativeUsage: ContextCumulativeUsage | undefined =
      turnCount > 0
        ? {
            totalTokens:
              inputTokens +
              outputTokens +
              cacheReadTokens +
              cacheCreationTokens,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            turnCount,
          }
        : undefined;

    return {
      records,
      model,
      messageCount,
      contextUsage,
      cumulativeUsage,
      firstPromptText,
    };
  }

  private extractUserQuestions(
    records: KimiWireRecord[],
    sessionId: string,
  ): SessionQuestion[] {
    const questions: SessionQuestion[] = [];
    let index = 0;
    for (const record of records) {
      if (!isKimiTurnPromptRecord(record)) continue;
      const question = createSessionQuestion(
        {
          id: `${sessionId}-user-${index}`,
          text: getKimiPromptText(record.input),
          timestamp: record.time ? new Date(record.time).toISOString() : "",
        },
        `kimi-user-${index}`,
      );
      if (question) questions.push(question);
      index += 1;
    }
    return questions;
  }
}

/**
 * Extract subagent ids from an Agent / AgentSwarm tool.result output.
 *
 * Single Agent result:
 *   `agent_id: agent-0\nactual_subagent_type: explore\nstatus: completed\n...`
 * AgentSwarm result:
 *   `<agent_swarm_result><subagent agent_id="agent-0" ...>...</subagent>...`
 */
export function parseKimiSubagentIds(output: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  // AgentSwarm: one <subagent agent_id="..."> per child.
  for (const m of output.matchAll(/<subagent[^>]*\bagent_id="([^"]+)"/g)) {
    add(m[1]);
  }
  // Single Agent: leading `agent_id: <id>` line.
  const single = output.match(/^\s*agent_id:\s*(\S+)/m);
  if (single) add(single[1]);

  return ids;
}

/**
 * Infer a subagent's status from its own wire records. History view only sees
 * terminal states: a `turn.cancel` marks an interrupted/failed run, otherwise
 * a subagent with produced content is treated as completed.
 */
function inferKimiAgentStatus(
  records: KimiWireRecord[],
  messages: Message[],
): "pending" | "running" | "completed" | "failed" {
  if (messages.length === 0) return "pending";
  for (const record of records) {
    if ((record as { type?: string }).type === "turn.cancel") return "failed";
  }
  return "completed";
}
