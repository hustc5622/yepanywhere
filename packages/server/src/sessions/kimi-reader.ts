/**
 * KimiSessionReader - Reads Kimi Code CLI sessions from disk.
 *
 * Kimi stores sessions under
 *   ~/.kimi-code/sessions/<workspace>/session_<uuid>/
 *     ├── state.json               (title / timestamps / workDir or cwd)
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
  type AgentMapping,
  type AgentStatus,
  type ContextCumulativeUsage,
  type KimiStepEndEvent,
  type KimiSubagentStatus,
  type KimiToolCallEvent,
  type KimiToolResultEvent,
  type KimiWireRecord,
  SESSION_TITLE_MAX_LENGTH,
  type SessionQuestion,
  type SubagentDescriptor,
  type SubagentMetrics,
  type UrlProjectId,
  deriveKimiSubagentMetrics,
  getKimiPromptText,
  getKimiSubagentType,
  getModelContextWindow,
  inferKimiSubagentStatus,
  isKimiLoopEventRecord,
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
import { sanitizePublicUserPrompt } from "./public-user-prompt.js";
import type { AgentSession as AgentSessionResult } from "./reader.js";
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
  /** Project cwd to filter sessions by (normalized from state workDir/cwd). */
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
  reasoningEffort: string | undefined;
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

  /** Drop the short-lived directory scan after a Kimi watcher event. */
  invalidateCache(): void {
    this.sessionFileCache.clear();
    this.cacheTimestamp = 0;
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
      const fullTitle = sanitizePublicUserPrompt(
        entry.title && entry.title !== "New Session"
          ? entry.title
          : (derived.firstPromptText ?? entry.title ?? ""),
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
        reasoningEffort: derived.reasoningEffort,
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
    try {
      const fingerprint = await this.getSessionFileStats(sessionId);
      if (!fingerprint) return null;
      if (
        fingerprint.mtime === cachedMtime &&
        fingerprint.size === cachedSize
      ) {
        return null;
      }

      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;
      return { summary, ...fingerprint };
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
   * The parent tool.result is the authoritative, non-heuristic identity source
   * (each result lands the moment its child finishes, independent of the parent
   * turn ending). An `AgentSwarm` call fans out to N children that all share
   * one `toolUseId`; we emit one mapping per child, each with its `swarmIndex`,
   * so callers can render the full fan-out instead of only the first child.
   *
   * Kimi agent ids (`agent-0`, `agent-1`, ...) are only unique within a
   * session, so this must be scoped by sessionId — the route forwards it.
   */
  async getAgentMappings(sessionId?: string): Promise<AgentMapping[]> {
    if (!sessionId) return [];
    const entry = await this.findSessionFile(sessionId);
    if (!entry) return [];

    let records: KimiWireRecord[];
    try {
      records = parseKimiWireJsonl(await readFile(entry.filePath, "utf-8"));
    } catch {
      return [];
    }

    // Requested subagent type per spawning tool call (from the call args).
    const requestedTypeByCallId = new Map<string, string | undefined>();
    // Raw tool.result output text per spawning tool call.
    const resultOutputByCallId = new Map<string, string>();
    // Preserve tool.call order so swarmIndex fallback (per-call ordinal) is
    // deterministic; the child's own `swarmIndex` from the result wins.
    const spawnCallIds: string[] = [];

    for (const record of records) {
      if (!isKimiLoopEventRecord(record)) continue;
      const event = record.event;
      if (event.type === "tool.call") {
        const call = event as KimiToolCallEvent;
        if (call.name === "Agent" || call.name === "AgentSwarm") {
          if (!requestedTypeByCallId.has(call.toolCallId)) {
            spawnCallIds.push(call.toolCallId);
          }
          const argType = call.args?.subagent_type;
          requestedTypeByCallId.set(
            call.toolCallId,
            typeof argType === "string" ? argType : undefined,
          );
        }
      } else if (event.type === "tool.result") {
        const res = event as KimiToolResultEvent;
        const output = res.result?.output;
        if (typeof output === "string" && res.toolCallId) {
          resultOutputByCallId.set(res.toolCallId, output);
        }
      }
    }

    const mappings: AgentMapping[] = [];
    for (const toolUseId of spawnCallIds) {
      const output = resultOutputByCallId.get(toolUseId);
      if (!output) continue; // No result yet → no authoritative identity.
      const children = parseKimiSubagentResults(output);
      const requestedType = requestedTypeByCallId.get(toolUseId);
      children.forEach((child, index) => {
        mappings.push({
          toolUseId,
          agentId: child.agentId,
          ...((child.type ?? requestedType)
            ? { agentType: child.type ?? requestedType }
            : {}),
          swarmIndex: child.swarmIndex ?? index,
          ...(child.status ? { status: child.status } : {}),
        });
      });
    }
    return mappings;
  }

  /**
   * Load a subagent transcript from `agents/<agentId>/wire.jsonl`, along with
   * its derived run metrics and lifecycle status.
   *
   * agentId (e.g. `agent-0`) is only unique within a session, so sessionId is
   * required to locate the owning session directory.
   *
   * Status resolution is authoritative: when the parent tool.result already
   * carries a terminal outcome for this child (`status: completed|failed`, or
   * an AgentSwarm `outcome="..."`), that wins; otherwise the child's own wire
   * (`turn.cancel`, `step.end.finishReason`) is used. It never infers
   * "completed" just because the transcript is non-empty.
   */
  async getAgentSession(
    agentId: string,
    sessionId?: string,
  ): Promise<AgentSessionResult | null> {
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

    const resolved = await this.resolveSubagentFromParent(entry, agentId);
    const detailedStatus = inferKimiSubagentStatus(records, resolved?.status);
    const agentType = getKimiSubagentType(records) ?? resolved?.type;
    const metrics: SubagentMetrics = deriveKimiSubagentMetrics(records);
    const { startedAt, completedAt } = kimiSubagentTimespan(
      records,
      detailedStatus,
    );

    const descriptor: SubagentDescriptor = {
      agentId,
      parentAgentId: "main",
      status: detailedStatus,
      ...(resolved?.toolUseId ? { parentToolUseId: resolved.toolUseId } : {}),
      ...(agentType ? { type: agentType } : {}),
      ...(resolved?.description ? { description: resolved.description } : {}),
      ...(resolved?.swarmIndex !== undefined
        ? { swarmIndex: resolved.swarmIndex }
        : {}),
      ...(resolved?.runInBackground ? { runInBackground: true } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    };

    return {
      messages,
      status: subagentToAgentStatus(detailedStatus),
      ...(agentType ? { agentType } : {}),
      metrics,
      descriptor,
    };
  }

  /**
   * Resolve the parent tool.call/tool.result linkage for a given child agent
   * id from the main wire. Returns the spawning `toolUseId`, requested type,
   * description, swarm index, and the authoritative terminal status parsed
   * from the parent result — or undefined when no result has landed yet.
   */
  private async resolveSubagentFromParent(
    entry: KimiSessionCacheEntry,
    agentId: string,
  ): Promise<
    | {
        toolUseId: string;
        type?: string;
        description?: string;
        swarmIndex?: number;
        status?: KimiSubagentStatus;
        runInBackground?: boolean;
      }
    | undefined
  > {
    let records: KimiWireRecord[];
    try {
      records = parseKimiWireJsonl(await readFile(entry.filePath, "utf-8"));
    } catch {
      return undefined;
    }

    const callMeta = new Map<string, { type?: string; description?: string }>();
    for (const record of records) {
      if (!isKimiLoopEventRecord(record)) continue;
      const event = record.event;
      if (event.type === "tool.call") {
        const call = event as KimiToolCallEvent;
        if (call.name === "Agent" || call.name === "AgentSwarm") {
          const argType = call.args?.subagent_type;
          const argDescription = call.args?.description;
          callMeta.set(call.toolCallId, {
            type: typeof argType === "string" ? argType : undefined,
            description:
              typeof argDescription === "string" ? argDescription : undefined,
          });
        }
      } else if (event.type === "tool.result") {
        const res = event as KimiToolResultEvent;
        const output = res.result?.output;
        if (typeof output !== "string" || !res.toolCallId) continue;
        const children = parseKimiSubagentResults(output);
        const match = children.find((c) => c.agentId === agentId);
        if (match) {
          const meta = callMeta.get(res.toolCallId);
          return {
            toolUseId: res.toolCallId,
            type: match.type ?? meta?.type,
            description: meta?.description,
            swarmIndex: match.swarmIndex,
            status: match.status,
            runInBackground: match.runInBackground,
          };
        }
      }
    }
    return undefined;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const entry = await this.findSessionFile(sessionId);
    return entry?.filePath ?? null;
  }

  async getSessionFileStats(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null> {
    const entry = await this.findSessionFile(sessionId);
    if (!entry) return null;

    try {
      const fingerprint = await this.getSessionFingerprint(
        entry.filePath,
        entry.sessionDir,
      );
      if (
        fingerprint.mtime === entry.mtime &&
        fingerprint.size === entry.size
      ) {
        return fingerprint;
      }

      const refreshedEntry = await this.readSessionMeta(
        sessionId,
        entry.sessionDir,
      );
      if (!refreshedEntry) return null;
      this.sessionFileCache.set(sessionId, refreshedEntry);
      return {
        mtime: refreshedEntry.mtime,
        size: refreshedEntry.size,
      };
    } catch {
      return null;
    }
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
      const fingerprint = await this.getSessionFingerprint(
        filePath,
        sessionDir,
      );
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
        mtime: fingerprint.mtime,
        size: fingerprint.size,
      };
    } catch {
      // No wire.jsonl — not a usable session.
      return null;
    }
  }

  /**
   * Build the cache fingerprint from both transcript and state metadata.
   * Kimi can update title/cwd/timestamps without touching wire.jsonl, so using
   * only the wire stat would leave summary and search indexes stale forever.
   */
  private async getSessionFingerprint(
    filePath: string,
    sessionDir: string,
  ): Promise<{ mtime: number; size: number }> {
    const wireStats = await stat(filePath);
    const stateStats = await stat(join(sessionDir, "state.json")).catch(
      () => null,
    );

    return {
      mtime: Math.max(wireStats.mtimeMs, stateStats?.mtimeMs ?? 0),
      size: wireStats.size + (stateStats?.size ?? 0),
    };
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
    let reasoningEffort: string | undefined;
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
      if (record.type === "config.update") {
        const config = record as {
          modelAlias?: unknown;
          thinkingEffort?: unknown;
        };
        if (typeof config.modelAlias === "string" && config.modelAlias) {
          model = config.modelAlias;
        }
        if (
          typeof config.thinkingEffort === "string" &&
          config.thinkingEffort
        ) {
          reasoningEffort = config.thinkingEffort;
        }
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
      reasoningEffort,
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
 * A single child parsed from an Agent / AgentSwarm tool.result output, with
 * its terminal status and (for swarms) its position.
 */
export interface KimiSubagentResult {
  agentId: string;
  status?: KimiSubagentStatus;
  type?: string;
  swarmIndex?: number;
  runInBackground?: boolean;
}

/**
 * Parse the child agent id(s) + terminal status from an Agent / AgentSwarm
 * tool.result output.
 *
 * Single Agent result:
 *   `agent_id: agent-0\nactual_subagent_type: explore\nstatus: completed\n...`
 *   (background launches carry `status: running`.)
 * AgentSwarm result:
 *   `<agent_swarm_result><subagent agent_id="agent-0" outcome="completed"
 *    ...>...</subagent>...`
 */
export function parseKimiSubagentResults(output: string): KimiSubagentResult[] {
  const results: KimiSubagentResult[] = [];
  const seen = new Set<string>();
  const push = (result: KimiSubagentResult) => {
    if (!result.agentId || seen.has(result.agentId)) return;
    seen.add(result.agentId);
    results.push(result);
  };

  // AgentSwarm: one <subagent agent_id="..." outcome="..." ...> per child.
  let swarmIndex = 0;
  for (const m of output.matchAll(/<subagent\b([^>]*)>/gi)) {
    const attrs = m[1] ?? "";
    const agentId = attrs.match(/\bagent_id\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!agentId) continue;
    const outcome = attrs.match(/\boutcome\s*=\s*["']([^"']+)["']/i)?.[1];
    const type = attrs.match(
      /\b(?:actual_subagent_type|subagent_type|type)\s*=\s*["']([^"']+)["']/i,
    )?.[1];
    push({
      agentId,
      status: mapKimiOutcomeToStatus(outcome),
      ...(type ? { type } : {}),
      swarmIndex: swarmIndex++,
    });
  }

  if (results.length > 0) return results;

  // Single Agent: leading `agent_id: <id>` line + `status:` + type lines.
  const agentId = output.match(/^\s*agent_id:\s*(\S+)/m)?.[1];
  if (agentId) {
    const statusText = output.match(/^\s*status:\s*(\S+)/m)?.[1];
    const type = output.match(/^\s*actual_subagent_type:\s*(\S+)/m)?.[1];
    const runInBackground = /^\s*automatic_notification:\s*true\s*$/im.test(
      output,
    );
    push({
      agentId,
      status: runInBackground
        ? "backgrounded"
        : mapKimiOutcomeToStatus(statusText),
      ...(type ? { type } : {}),
      ...(runInBackground ? { runInBackground: true } : {}),
    });
  }

  return results;
}

/**
 * @deprecated Use {@link parseKimiSubagentResults}. Kept for callers that only
 * need the ordered id list.
 */
export function parseKimiSubagentIds(output: string): string[] {
  return parseKimiSubagentResults(output).map((r) => r.agentId);
}

/** Map a Kimi tool.result `status:` / swarm `outcome=` token to a status. */
function mapKimiOutcomeToStatus(
  token: string | undefined,
): KimiSubagentStatus | undefined {
  if (!token) return undefined;
  const normalized = token.trim().toLowerCase();
  switch (normalized) {
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "aborted":
    case "interrupted":
      return "interrupted";
    case "timeout":
    case "timed_out":
      return "failed";
    case "suspended":
      return "suspended";
    case "running":
      return "running";
    default:
      return undefined;
  }
}

/**
 * Compute a subagent's run timespan from its wire records. `startedAt` is the
 * earliest record timestamp (metadata.created_at or the first `time`);
 * `completedAt` is the latest timestamp, only reported once the run reached a
 * terminal status (so a still-running agent has no completion time).
 */
function kimiSubagentTimespan(
  records: readonly KimiWireRecord[],
  status: KimiSubagentStatus,
): { startedAt?: string; completedAt?: string } {
  let first: number | undefined;
  let last: number | undefined;
  for (const record of records) {
    const t =
      typeof (record as { time?: unknown }).time === "number"
        ? (record as { time: number }).time
        : record.type === "metadata" &&
            typeof (record as { created_at?: unknown }).created_at === "number"
          ? (record as { created_at: number }).created_at
          : undefined;
    if (t === undefined) continue;
    if (first === undefined || t < first) first = t;
    if (last === undefined || t > last) last = t;
  }
  const terminal =
    status === "completed" || status === "failed" || status === "interrupted";
  return {
    ...(first !== undefined
      ? { startedAt: new Date(first).toISOString() }
      : {}),
    ...(terminal && last !== undefined
      ? { completedAt: new Date(last).toISOString() }
      : {}),
  };
}

/** Collapse the rich subagent lifecycle to the coarse {@link AgentStatus}. */
function subagentToAgentStatus(status: KimiSubagentStatus): AgentStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    case "running":
    case "starting":
    case "suspended":
    case "backgrounded":
      return "running";
    default:
      return "pending";
  }
}
