/**
 * ZCode SQLite session reader.
 *
 * Implements `ISessionReader` against `~/.zcode/cli/db/db.sqlite`, reading
 * the `session`, `message`, and `part` tables. All queries are read-only;
 * the reader never writes, migrates, or repairs the ZCode SQLite database.
 *
 * Provider-neutral SQLite worker handles are cached per `dbPath`, so ZCode
 * queries get their own pooled connections.
 *
 * Column mapping (verified against the actual ZCode SQLite schema):
 *   - session: id, project_id, parent_id, directory, title, permission,
 *     time_created, time_updated, time_archived, task_type, version, slug
 *   - message: id, session_id, time_created, time_updated, data (JSON), sequence
 *   - part: id, message_id, session_id, time_created, time_updated, data (JSON), sequence
 *
 * Ordering:
 *   - messages: `sequence IS NULL, sequence, time_created, rowid`
 *   - parts: `message_id, sequence IS NULL, sequence, time_created, id`
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentMapping,
  ProviderName,
  SessionBranchState,
  SubagentDescriptor,
  SubagentMetrics,
  SubagentStatus,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type {
  ZCodeSessionContent,
  ZCodeStoredMessage,
  ZCodeStoredPart,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import { querySqliteRow, querySqliteRowsOrEmpty } from "../sqlite/query.js";
import type { Message, SessionSummary } from "../supervisor/types.js";
import { convertZCodeMessages } from "./normalization.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
  SessionFileEntry,
} from "./types.js";
import { buildZCodeBranchView } from "./zcode-branch.js";
import { ZCODE_DB_PATH } from "./zcode-db.js";

const log = getLogger().child({ component: "zcode-reader" });

// =============================================================================
// SQL constants
// =============================================================================

/** Columns to select from the `session` table (never SELECT * — avoid logging title). */
const SESSION_COLUMNS = `
  id, project_id, parent_id, directory, title, version, slug,
  permission, task_type, title_source,
  time_created, time_updated, time_archived
`;

// Edit-fork child sessions carry parent_id but keep the parent's interactive
// task_type; only subagent children are hidden from the session list.
const LIST_SESSIONS_SQL = `
  SELECT ${SESSION_COLUMNS}
  FROM session
  WHERE directory = ?
    AND time_archived IS NULL
    AND (parent_id IS NULL OR COALESCE(task_type, 'interactive') <> 'subagent_child')
  ORDER BY time_updated DESC
`;

const GET_SESSION_SQL = `
  SELECT ${SESSION_COLUMNS}
  FROM session
  WHERE id = ? AND directory = ? AND time_archived IS NULL
`;

const GET_SESSION_STATS_SQL = `
  SELECT
    s.time_updated AS mtime,
    (SELECT COUNT(*) FROM message WHERE session_id = s.id) * 1000000
    + (SELECT COUNT(*) FROM part WHERE session_id = s.id) AS size
  FROM session s
  WHERE s.id = ? AND s.directory = ?
`;

const LIST_MESSAGES_SQL = `
  SELECT id, session_id, time_created, time_updated, data
  FROM message
  WHERE session_id = ?
  ORDER BY sequence IS NULL, sequence, time_created, rowid
`;

const LIST_PARTS_SQL = `
  SELECT id, message_id, session_id, time_created, time_updated, data
  FROM part
  WHERE session_id = ?
  ORDER BY message_id, sequence IS NULL, sequence, time_created, id
`;

const LIST_SESSION_IDS_FOR_PROJECT_SQL = `
  SELECT id, time_updated
  FROM session
  WHERE directory = ?
    AND time_archived IS NULL
    AND COALESCE(task_type, 'interactive') <> 'subagent_child'
  ORDER BY time_updated DESC
`;

/** Candidate rows for edit-fork family assembly (lineage + ordering only). */
const LIST_FAMILY_CANDIDATES_SQL = `
  SELECT id, parent_id, task_type, time_created
  FROM session
  WHERE directory = ? AND time_archived IS NULL
`;

// =============================================================================
// Options
// =============================================================================

export interface ZCodeSessionReaderOptions {
  dbPath?: string;
  projectPath: string;
  getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
  /**
   * Yep sidecar edit-fork lineage: complements the native sqlite parent_id
   * for fork edge assembly (native parent_id wins when both exist).
   */
  getForkParentSessionId?: (sessionId: string) => string | undefined;
  /**
   * ZCode agent metadata directory (default derived from dbPath:
   * <zcode>/cli/agents). Primarily a test seam.
   */
  agentsDir?: string;
}

// =============================================================================
// Reader
// =============================================================================

export class ZCodeSessionReader implements ISessionReader {
  private readonly dbPath: string;
  private readonly projectPath: string;
  private readonly getContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
    sessionId?: string,
  ) => number | undefined;
  private readonly getForkParentSessionId?:
    | ((sessionId: string) => string | undefined)
    | undefined;
  private readonly optionsAgentsDir?: string;

  constructor(options: ZCodeSessionReaderOptions) {
    this.dbPath = options.dbPath ?? ZCODE_DB_PATH;
    this.projectPath = canonicalizeProjectPath(options.projectPath);
    this.getContextWindow = options.getContextWindow;
    this.getForkParentSessionId = options.getForkParentSessionId;
    this.optionsAgentsDir = options.agentsDir;
  }

  // -------------------------------------------------------------------------
  // ISessionReader: list / get
  // -------------------------------------------------------------------------

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const rows = await querySqliteRowsOrEmpty(
      this.dbPath,
      LIST_SESSIONS_SQL,
      [this.projectPath],
      { label: "zcode.listSessions" },
    );

    return rows.map((row) => this.buildSummary(row, projectId));
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const result = await querySqliteRow(
      this.dbPath,
      GET_SESSION_SQL,
      [sessionId, this.projectPath],
      { label: "zcode.getSessionSummary" },
    );
    if (!result.ok) return null;
    const row = result.value;
    if (!row) return null;
    return this.buildSummary(row, projectId);
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    _afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const sessionResult = await querySqliteRow(
      this.dbPath,
      GET_SESSION_SQL,
      [sessionId, this.projectPath],
      { label: "zcode.getSession" },
    );
    if (!sessionResult.ok || !sessionResult.value) return null;
    const sessionRow = sessionResult.value;

    const messages = await this.loadStoredMessages(
      sessionId,
      "zcode.getSession",
    );

    const sessionContent: ZCodeSessionContent = {
      sessionId: String(sessionRow.id ?? sessionId),
      title: asString(sessionRow.title),
      directory: asString(sessionRow.directory),
      createdAt: asNumber(sessionRow.time_created),
      updatedAt: asNumber(sessionRow.time_updated),
      mode: extractMode(sessionRow.permission),
      archived: asNumber(sessionRow.time_archived) != null,
      messages,
    };

    const summary = this.buildSummary(sessionRow, projectId);
    const branchState = await this.loadBranchState(
      sessionId,
      options?.branchId,
    );

    return {
      summary,
      data: { provider: "zcode", session: sessionContent },
      ...(branchState ? { branchState } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Provider-native edit-fork branch state.
  // -------------------------------------------------------------------------

  private async loadStoredMessages(
    sessionId: string,
    label: string,
  ): Promise<ZCodeStoredMessage[]> {
    const [messageRows, partRows] = await Promise.all([
      querySqliteRowsOrEmpty(this.dbPath, LIST_MESSAGES_SQL, [sessionId], {
        label: `${label}.messages`,
      }),
      querySqliteRowsOrEmpty(this.dbPath, LIST_PARTS_SQL, [sessionId], {
        label: `${label}.parts`,
      }),
    ]);
    const partsByMessage = groupPartsByMessage(partRows);
    return messageRows.map((row) => mapMessageRow(row, partsByMessage));
  }

  /**
   * Assemble the edit-fork family around `currentSessionId` and build its
   * branch view. Edges union the native sqlite `parent_id` with Yep's
   * sidecar `forkParentSessionId` metadata; subagent children are never fork
   * edges. Returns undefined for singleton families.
   */
  private async loadBranchState(
    currentSessionId: string,
    selectedBranchId?: string,
  ): Promise<SessionBranchState | undefined> {
    const rows = await querySqliteRowsOrEmpty(
      this.dbPath,
      LIST_FAMILY_CANDIDATES_SQL,
      [this.projectPath],
      { label: "zcode.loadBranchState.family" },
    );

    const sessionById = new Map<
      string,
      { parentId?: string; createdAt?: string }
    >();
    for (const row of rows) {
      const id = asString(row.id);
      if (!id) continue;
      const createdAtMs = asNumber(row.time_created);
      sessionById.set(id, {
        ...(createdAtMs !== undefined
          ? { createdAt: new Date(createdAtMs).toISOString() }
          : {}),
      });
    }
    if (!sessionById.has(currentSessionId)) return undefined;

    // Edge source: native parent_id wins; the Yep sidecar fills sessions
    // whose native lineage is absent. Subagent children never form edges —
    // their parent link is task routing, not edit forking.
    const parentOf = new Map<string, string>();
    for (const row of rows) {
      const id = asString(row.id);
      if (!id) continue;
      if (asString(row.task_type) === "subagent_child") continue;
      const parentId =
        asString(row.parent_id) ?? this.getForkParentSessionId?.(id);
      if (parentId && sessionById.has(parentId)) {
        parentOf.set(id, parentId);
      }
    }
    if (parentOf.size === 0) return undefined;

    // Walk up to the family root, then BFS down to collect every member.
    let rootId = currentSessionId;
    const visited = new Set<string>([currentSessionId]);
    while (parentOf.has(rootId)) {
      const next = parentOf.get(rootId) as string;
      if (visited.has(next)) break;
      rootId = next;
      visited.add(next);
    }
    const childrenByParent = new Map<string, string[]>();
    for (const [child, parent] of parentOf) {
      const children = childrenByParent.get(parent) ?? [];
      children.push(child);
      childrenByParent.set(parent, children);
    }
    const familyIds: string[] = [];
    const queue = [rootId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      familyIds.push(id);
      queue.push(...(childrenByParent.get(id) ?? []));
    }
    if (familyIds.length <= 1) return undefined;

    const familySessions = await Promise.all(
      familyIds.map(async (id) => ({
        id,
        parentId: parentOf.get(id) ?? null,
        ...(sessionById.get(id)?.createdAt
          ? { createdAt: sessionById.get(id)?.createdAt }
          : {}),
        messages: await this.loadStoredMessages(id, "zcode.loadBranchState"),
      })),
    );

    const view = buildZCodeBranchView(
      familySessions,
      currentSessionId,
      selectedBranchId,
    );
    for (const diagnostic of view.diagnostics) {
      log.warn(
        { event: "zcode_branch_view_diagnostic", ...diagnostic },
        "ZCode branch view diagnostic",
      );
    }
    return view.branchState;
  }

  // -------------------------------------------------------------------------
  // ISessionReader: change detection
  // -------------------------------------------------------------------------

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const statsResult = await querySqliteRow(
      this.dbPath,
      GET_SESSION_STATS_SQL,
      [sessionId, this.projectPath],
      { label: "zcode.getSessionSummaryIfChanged" },
    );
    if (!statsResult.ok || !statsResult.value) return null;
    const statsRow = statsResult.value;

    const mtime = asNumber(statsRow.mtime) ?? 0;
    const size = asNumber(statsRow.size) ?? 0;
    if (mtime === cachedMtime && size === cachedSize) return null;

    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;
    return { summary, mtime, size };
  }

  // -------------------------------------------------------------------------
  // ISessionReader: subagent support
  //
  // Authoritative link (verified against real CLI 0.16.1 data):
  //   ~/.zcode/cli/agents/<parentSessionId>/agent_<agentId>/metadata.json
  //     { agentId, childSessionId, parentSessionId, parentToolUseId,
  //       description, prompt, profileId, profileSnapshot:{name,...},
  //       status, createdAt, completedAt, usage, totalToolUseCount, ... }
  //   metadata.parentToolUseId == the parent session's Agent tool part callID
  //   metadata.childSessionId  == the sqlite subagent_child session id
  // The DB-only path is deliberate: the reader is offline, `session/subagents`
  // needs a live app-server for full lifecycle detail.
  // -------------------------------------------------------------------------

  private get agentsDir(): string {
    // dbPath = <zcode>/cli/db/db.sqlite → agents = <zcode>/cli/agents
    return (
      this.optionsAgentsDir ?? join(dirname(dirname(this.dbPath)), "agents")
    );
  }

  /**
   * Parse every "agent_<id>/metadata.json" under <agentsDir>/<sessionId>.
   * Only structural fields are read; prompt/output contents never enter logs.
   */
  private async loadSubagentMetadata(
    sessionId: string,
  ): Promise<ZCodeSubagentMetadata[]> {
    const parentDir = join(this.agentsDir, sessionId);
    let entries: string[];
    try {
      entries = (await fs.readdir(parentDir)).sort();
    } catch {
      return [];
    }
    const subs: ZCodeSubagentMetadata[] = [];
    for (const entry of entries) {
      if (!entry.startsWith("agent_")) continue;
      try {
        const raw = await fs.readFile(
          join(parentDir, entry, "metadata.json"),
          "utf-8",
        );
        const parsed = parseJsonRecord(raw) as
          | (Record<string, unknown> & ZCodeSubagentMetadata)
          | null;
        if (parsed) subs.push(parsed);
      } catch {
        // Tolerate a partially written metadata file; skip just this agent.
      }
    }
    return subs;
  }

  async getAgentMappings(sessionId?: string): Promise<AgentMapping[]> {
    if (!sessionId) return [];
    const subs = await this.loadSubagentMetadata(sessionId);
    const mappings: AgentMapping[] = [];
    for (const sub of subs) {
      const toolUseId = asString(sub.parentToolUseId);
      const agentId = asString(sub.childSessionId) ?? asString(sub.agentId);
      if (!toolUseId || !agentId) continue;
      const agentType =
        asString(sub.profileSnapshot?.name) ?? asString(sub.profileId);
      mappings.push({
        toolUseId,
        agentId,
        ...(agentType ? { agentType } : {}),
        status: mapZCodeSubagentStatus(asString(sub.status)),
      });
    }
    return mappings;
  }

  async getAgentSession(
    agentId: string,
    sessionId?: string,
  ): Promise<{
    messages: Message[];
    status: string;
    metrics?: SubagentMetrics;
    descriptor?: SubagentDescriptor;
  } | null> {
    if (!/^[\w.-]+$/.test(agentId) || agentId.includes("..")) return null;

    // Metadata provides the authoritative parent/command linkage; when a
    // session scope is given, the child must belong to it.
    let metadata: ZCodeSubagentMetadata | undefined;
    if (sessionId) {
      const subs = await this.loadSubagentMetadata(sessionId);
      metadata = subs.find(
        (sub) =>
          sub.childSessionId === agentId ||
          (sub.agentId === agentId && sub.childSessionId === undefined),
      );
      if (!metadata) return null;
    }

    const sessionResult = await querySqliteRow(
      this.dbPath,
      GET_SESSION_SQL,
      [agentId, this.projectPath],
      { label: "zcode.getAgentSession" },
    );
    if (!sessionResult.ok || !sessionResult.value) return null;

    const stored = await this.loadStoredMessages(
      agentId,
      "zcode.getAgentSession",
    );
    const messages = convertZCodeMessages({
      sessionId: agentId,
      messages: stored,
    });

    const status = mapZCodeSubagentStatus(asString(metadata?.status));
    const agentType =
      asString(metadata?.profileSnapshot?.name) ??
      asString(metadata?.profileId);

    const metrics: SubagentMetrics = {
      ...(typeof metadata?.totalToolUseCount === "number"
        ? { toolUseCount: metadata.totalToolUseCount }
        : {}),
      ...(typeof metadata?.totalDurationMs === "number"
        ? { durationMs: metadata.totalDurationMs }
        : {}),
      ...(typeof metadata?.totalTokens === "number"
        ? { usage: { totalTokens: metadata.totalTokens } }
        : {}),
    };

    const descriptor: SubagentDescriptor = {
      agentId,
      parentAgentId: "main",
      status,
      ...(asString(metadata?.parentToolUseId)
        ? { parentToolUseId: asString(metadata?.parentToolUseId) }
        : {}),
      ...(agentType ? { type: agentType } : {}),
      ...(asString(metadata?.description)
        ? { description: asString(metadata?.description) }
        : {}),
      ...(asString(metadata?.createdAt)
        ? { startedAt: asString(metadata?.createdAt) }
        : {}),
      ...(asString(metadata?.completedAt)
        ? { completedAt: asString(metadata?.completedAt) }
        : {}),
    };

    return {
      messages,
      status,
      ...(agentType ? { agentType } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      descriptor,
    };
  }

  // -------------------------------------------------------------------------
  // ISessionReader: file access
  // -------------------------------------------------------------------------

  async getSessionFilePath(_sessionId: string): Promise<string | null> {
    // ZCode sessions live in a shared SQLite DB, not individual files.
    return this.dbPath;
  }

  async getSessionFileStats(
    sessionId: string,
  ): Promise<{ mtime: number; size: number } | null> {
    const result = await querySqliteRow(
      this.dbPath,
      GET_SESSION_STATS_SQL,
      [sessionId, this.projectPath],
      { label: "zcode.getSessionFileStats" },
    );
    if (!result.ok || !result.value) return null;
    const row = result.value;
    return {
      mtime: asNumber(row.mtime) ?? 0,
      size: asNumber(row.size) ?? 0,
    };
  }

  async listSessionFiles(_sessionDir: string): Promise<SessionFileEntry[]> {
    const rows = await querySqliteRowsOrEmpty(
      this.dbPath,
      LIST_SESSION_IDS_FOR_PROJECT_SQL,
      [this.projectPath],
      { label: "zcode.listSessionFiles" },
    );
    return rows.map((row) => ({
      sessionId: String(row.id),
      filePath: this.dbPath,
      mtime: asNumber(row.time_updated) ?? 0,
    }));
  }

  getIndexScopeKey(_sessionDir: string): string {
    return `zcode::${this.dbPath}::${this.projectPath}`;
  }

  // -------------------------------------------------------------------------
  // Internal: summary builder
  // -------------------------------------------------------------------------

  private buildSummary(
    row: Record<string, unknown>,
    projectId: UrlProjectId,
  ): SessionSummary {
    const sessionId = String(row.id ?? "");
    const title = asString(row.title);
    const timeCreated = asNumber(row.time_created);
    const timeUpdated = asNumber(row.time_updated);
    // A parent_id on a non-subagent session marks a native edit-fork child;
    // exposing it lets list views collapse the fork family onto its parent.
    const parentId =
      asString(row.parent_id) && asString(row.task_type) !== "subagent_child"
        ? asString(row.parent_id)
        : undefined;

    return {
      id: sessionId,
      projectId,
      title: title ?? null,
      fullTitle: title ?? null,
      createdAt: timeCreated
        ? new Date(timeCreated).toISOString()
        : new Date(0).toISOString(),
      updatedAt: timeUpdated
        ? new Date(timeUpdated).toISOString()
        : new Date(0).toISOString(),
      messageCount: 0, // populated by enrichSummaryContext if needed
      ownership: { owner: "external" },
      isArchived: asNumber(row.time_archived) != null,
      provider: "zcode",
      ...(parentId ? { forkParentSessionId: parentId } : {}),
    };
  }
}

// =============================================================================
// Row mappers
// =============================================================================

function mapMessageRow(
  row: Record<string, unknown>,
  partsByMessage: Map<string, ZCodeStoredPart[]>,
): ZCodeStoredMessage {
  const messageId = String(row.id ?? "");
  const data = parseJsonRecord(row.data);
  const role = asString(data?.role) ?? "assistant";

  return {
    id: messageId,
    role,
    createdAt: asNumber(row.time_created),
    updatedAt: asNumber(row.time_updated),
    model: asString(data?.modelID),
    parentID: asString(data?.parentID),
    parts: partsByMessage.get(messageId) ?? [],
  };
}

function mapPartRow(row: Record<string, unknown>): ZCodeStoredPart | null {
  const partId = String(row.id ?? "");
  const messageID = String(row.message_id ?? "");
  const sessionID = String(row.session_id ?? "");
  const data = parseJsonRecord(row.data);
  if (!data) return null;
  const type = asString(data.type);
  if (!type) return null;

  return {
    id: partId,
    messageID,
    sessionID,
    type,
    ...data,
  };
}

function groupPartsByMessage(
  partRows: readonly Record<string, unknown>[],
): Map<string, ZCodeStoredPart[]> {
  const map = new Map<string, ZCodeStoredPart[]>();
  for (const row of partRows) {
    const part = mapPartRow(row);
    if (!part) continue;
    const existing = map.get(part.messageID) ?? [];
    existing.push(part);
    map.set(part.messageID, existing);
  }
  return map;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Structural view of ~/.zcode/cli/agents/<parentSessionId>/<agentDir>/metadata.json.
 * Only the fields the reader projects onto AgentMapping/SubagentDescriptor —
 * prompt and output contents are never mirrored here.
 */
interface ZCodeSubagentMetadata {
  agentId?: string;
  childSessionId?: string;
  parentSessionId?: string;
  parentToolUseId?: string;
  description?: string;
  prompt?: string;
  profileId?: string;
  profileSnapshot?: { name?: string };
  status?: string;
  createdAt?: string;
  completedAt?: string;
  totalToolUseCount?: number;
  totalDurationMs?: number;
  totalTokens?: number;
}

/**
 * Map ZCode subagent lifecycle statuses (observed `completed`; the bundle's
 * stopped enum also carries cancelled/failed/timed_out/spawn_error/lost and
 * running/waiting states) onto Yep's canonical SubagentStatus.
 */
function mapZCodeSubagentStatus(status: string | undefined): SubagentStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting":
    case "blocked":
    case "suspended":
      return "suspended";
    case "cancelled":
    case "stopped":
      return "interrupted";
    case "failed":
    case "timed_out":
    case "spawn_error":
    case "lost":
      return "failed";
    case "backgrounded":
      return "backgrounded";
    default:
      return "completed";
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      log.debug("Failed to parse JSON data column");
      return null;
    }
  }
  return null;
}

function extractMode(permission: unknown): string | undefined {
  const parsed = parseJsonRecord(permission);
  if (!parsed) return undefined;
  return asString(parsed.mode);
}
