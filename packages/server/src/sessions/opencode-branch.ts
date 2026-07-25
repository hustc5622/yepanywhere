import type {
  OpenCodeSessionEntry,
  SessionBranchOption,
  SessionBranchState,
} from "@yep-anywhere/shared";

export interface YepOpenCodeForkLineage {
  schemaVersion: 1;
  kind: "edit-fork";
  parentSessionId: string;
  forkMessageId: string;
  createdAt?: string;
}

export interface OpenCodeBranchSession {
  id: string;
  metadata: Record<string, unknown>;
  createdAt?: string;
  messages: OpenCodeSessionEntry[];
}

export interface OpenCodeBranchSessionMetadata {
  id: string;
  metadata: Record<string, unknown>;
  parentId?: string | null;
}

export interface OpenCodeBranchDiagnostic {
  code:
    | "invalid_metadata"
    | "missing_parent"
    | "missing_fork_message"
    | "lineage_cycle"
    | "duplicate_message_id";
  sessionId: string;
  parentSessionId?: string;
  forkMessageId?: string;
}

export interface OpenCodeBranchView {
  branchState?: SessionBranchState;
  diagnostics: OpenCodeBranchDiagnostic[];
}

interface ValidForkRelation {
  childSessionId: string;
  parentSessionId: string;
  forkMessageId: string;
  prefixMessageCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseForkLineage(
  session: OpenCodeBranchSessionMetadata,
  diagnostics?: OpenCodeBranchDiagnostic[],
): YepOpenCodeForkLineage | null {
  if (!Object.hasOwn(session.metadata, "yepFork")) return null;

  const raw = asRecord(session.metadata.yepFork);
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "edit-fork" ||
    typeof raw.parentSessionId !== "string" ||
    raw.parentSessionId.length === 0 ||
    typeof raw.forkMessageId !== "string" ||
    raw.forkMessageId.length === 0
  ) {
    diagnostics?.push({ code: "invalid_metadata", sessionId: session.id });
    return null;
  }

  return {
    schemaVersion: 1,
    kind: "edit-fork",
    parentSessionId: raw.parentSessionId,
    forkMessageId: raw.forkMessageId,
    ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
  };
}

/**
 * Find the metadata-defined family before loading transcripts. This deliberately
 * uses only Yep's versioned edit-fork metadata for edges; OpenCode parent_id is
 * only a negative subagent guard, and fork-like titles are not lineage signals.
 */
export function findOpenCodeBranchFamilySessionIds(
  sessions: OpenCodeBranchSessionMetadata[],
  currentSessionId: string,
  diagnostics: OpenCodeBranchDiagnostic[] = [],
): string[] {
  const sessionsById = new Map(
    sessions
      // Native OpenCode task/subagent sessions carry parent_id. Yep edit
      // forks are top-level sessions; excluding children also prevents a
      // future metadata-copying change from pulling subagents into a family.
      .filter((session) => !session.parentId)
      .map((session) => [session.id, session]),
  );
  if (!sessionsById.has(currentSessionId)) return [];

  const lineageByChild = new Map<string, YepOpenCodeForkLineage>();
  for (const session of sessionsById.values()) {
    const lineage = parseForkLineage(session, diagnostics);
    if (lineage) lineageByChild.set(session.id, lineage);
  }

  let rootSessionId = currentSessionId;
  const ancestors = new Set<string>([currentSessionId]);
  while (true) {
    const lineage = lineageByChild.get(rootSessionId);
    if (!lineage) break;
    if (!sessionsById.has(lineage.parentSessionId)) {
      diagnostics.push({
        code: "missing_parent",
        sessionId: rootSessionId,
        parentSessionId: lineage.parentSessionId,
        forkMessageId: lineage.forkMessageId,
      });
      break;
    }
    if (ancestors.has(lineage.parentSessionId)) {
      diagnostics.push({
        code: "lineage_cycle",
        sessionId: rootSessionId,
        parentSessionId: lineage.parentSessionId,
        forkMessageId: lineage.forkMessageId,
      });
      break;
    }
    rootSessionId = lineage.parentSessionId;
    ancestors.add(rootSessionId);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const [childSessionId, lineage] of lineageByChild) {
    if (!sessionsById.has(lineage.parentSessionId)) continue;
    const children = childrenByParent.get(lineage.parentSessionId) ?? [];
    children.push(childSessionId);
    childrenByParent.set(lineage.parentSessionId, children);
  }

  const family: string[] = [];
  const visited = new Set<string>();
  const queue = [rootSessionId];
  while (queue.length > 0) {
    const sessionId = queue.shift();
    if (!sessionId || visited.has(sessionId)) continue;
    visited.add(sessionId);
    family.push(sessionId);
    queue.push(...(childrenByParent.get(sessionId) ?? []));
  }
  return family;
}

/**
 * Extract the fork parent session id from a session's raw metadata, if the
 * session was created by a Yep edit-fork. Used by the session list to collapse
 * an edit-fork family into a single entry.
 */
export function readOpenCodeForkParentSessionId(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!metadata) return undefined;
  return parseForkLineage({ id: "", metadata })?.parentSessionId;
}

export interface CollapsibleForkFamilyMember {
  id: string;
  /** Set when this session is an edit-fork child of another session. */
  forkParentSessionId?: string;
  /** ISO timestamp used to pick the most recent member as the representative. */
  updatedAt: string;
}

/**
 * Collapse OpenCode edit-fork families down to a single representative per
 * family, mirroring Codex's single-session-with-branch-switcher UX. Because
 * OpenCode's native fork creates a brand new session per edit, a family would
 * otherwise surface as several independent list entries (plus a stray "Cont"
 * badge on the interrupted parent).
 *
 * The representative is the most recently updated member (the tip of the latest
 * edit / the branch currently being worked on). Hidden members remain directly
 * fetchable by id, so the branch switcher can still navigate to them.
 *
 * Sessions without fork lineage are singleton families and always kept. Order
 * of the input is preserved for the surviving entries.
 */
export function collapseOpenCodeForkFamilies<
  T extends CollapsibleForkFamilyMember,
>(summaries: T[]): T[] {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));

  // Union-find over the family graph. Each surviving edge points a child at its
  // fork parent; members without a resolvable parent stay their own root.
  const parentOf = new Map<string, string>();
  for (const summary of summaries) parentOf.set(summary.id, summary.id);
  const find = (id: string): string => {
    let root = id;
    while (parentOf.get(root) !== undefined && parentOf.get(root) !== root) {
      root = parentOf.get(root) as string;
    }
    let cursor = id;
    while (
      parentOf.get(cursor) !== undefined &&
      parentOf.get(cursor) !== root
    ) {
      const next = parentOf.get(cursor) as string;
      parentOf.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  let hasEdge = false;
  for (const summary of summaries) {
    const parentId = summary.forkParentSessionId;
    if (!parentId || !byId.has(parentId)) continue;
    const childRoot = find(summary.id);
    const parentRoot = find(parentId);
    if (childRoot !== parentRoot) parentOf.set(childRoot, parentRoot);
    hasEdge = true;
  }
  if (!hasEdge) return summaries;

  const representativeByRoot = new Map<string, T>();
  for (const summary of summaries) {
    const root = find(summary.id);
    const current = representativeByRoot.get(root);
    if (!current || isMoreRecentMember(summary, current)) {
      representativeByRoot.set(root, summary);
    }
  }

  const keep = new Set(
    [...representativeByRoot.values()].map((summary) => summary.id),
  );
  return summaries.filter((summary) => keep.has(summary.id));
}

function isMoreRecentMember(
  candidate: CollapsibleForkFamilyMember,
  current: CollapsibleForkFamilyMember,
): boolean {
  const candidateAt = new Date(candidate.updatedAt).getTime();
  const currentAt = new Date(current.updatedAt).getTime();
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  // Stable, deterministic tiebreak when timestamps match.
  return candidate.id > current.id;
}

function branchTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine || prompt.trim();
  return title.length <= 28 ? title : `${title.slice(0, 27)}...`;
}

function messageText(entry: OpenCodeSessionEntry): string {
  return entry.parts
    .filter(
      (part) =>
        part.type === "text" &&
        !part.synthetic &&
        typeof part.text === "string",
    )
    .map((part) => part.text ?? "")
    .join("");
}

function messageCreatedAt(entry: OpenCodeSessionEntry): string | undefined {
  const created = entry.message.time?.created;
  return typeof created === "number" && Number.isFinite(created)
    ? new Date(created).toISOString()
    : undefined;
}

function orderFamilySessions(
  rootSessionId: string,
  sessionsById: Map<string, OpenCodeBranchSession>,
  relations: Map<string, ValidForkRelation>,
): OpenCodeBranchSession[] {
  const childrenByParent = new Map<string, OpenCodeBranchSession[]>();
  for (const relation of relations.values()) {
    const child = sessionsById.get(relation.childSessionId);
    if (!child) continue;
    const children = childrenByParent.get(relation.parentSessionId) ?? [];
    children.push(child);
    childrenByParent.set(relation.parentSessionId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) =>
      (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id),
    );
  }

  const ordered: OpenCodeBranchSession[] = [];
  const visited = new Set<string>();
  const queue = [rootSessionId];
  while (queue.length > 0) {
    const sessionId = queue.shift();
    if (!sessionId || visited.has(sessionId)) continue;
    visited.add(sessionId);
    const session = sessionsById.get(sessionId);
    if (!session) continue;
    ordered.push(session);
    queue.push(
      ...(childrenByParent.get(sessionId) ?? []).map((child) => child.id),
    );
  }
  return ordered;
}

/**
 * Build a provider-agnostic branch state for a metadata-defined OpenCode fork
 * family. Copied prefix IDs are intentionally not compared across sessions.
 * The parent boundary locates the original option, while the count of ordered
 * messages before that boundary locates the first new user turn in the child.
 */
export function buildOpenCodeBranchView(
  sessions: OpenCodeBranchSession[],
  currentSessionId: string,
  selectedBranchId?: string,
): OpenCodeBranchView {
  const diagnostics: OpenCodeBranchDiagnostic[] = [];
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const current = sessionsById.get(currentSessionId);
  if (!current) return { diagnostics };

  const lineageByChild = new Map<string, YepOpenCodeForkLineage>();
  for (const session of sessions) {
    const lineage = parseForkLineage(session, diagnostics);
    if (lineage) lineageByChild.set(session.id, lineage);
  }

  const validRelations = new Map<string, ValidForkRelation>();
  for (const [childSessionId, lineage] of lineageByChild) {
    const parent = sessionsById.get(lineage.parentSessionId);
    if (!parent) {
      diagnostics.push({
        code: "missing_parent",
        sessionId: childSessionId,
        parentSessionId: lineage.parentSessionId,
        forkMessageId: lineage.forkMessageId,
      });
      continue;
    }
    const boundaryIndex = parent.messages.findIndex(
      (entry) =>
        entry.message.id === lineage.forkMessageId &&
        entry.message.role === "user",
    );
    if (boundaryIndex < 0) {
      diagnostics.push({
        code: "missing_fork_message",
        sessionId: childSessionId,
        parentSessionId: lineage.parentSessionId,
        forkMessageId: lineage.forkMessageId,
      });
      continue;
    }
    validRelations.set(childSessionId, {
      childSessionId,
      parentSessionId: lineage.parentSessionId,
      forkMessageId: lineage.forkMessageId,
      prefixMessageCount: boundaryIndex,
    });
  }

  let rootSessionId = currentSessionId;
  const ancestors = new Set<string>([currentSessionId]);
  while (true) {
    const relation = validRelations.get(rootSessionId);
    if (!relation) break;
    if (ancestors.has(relation.parentSessionId)) {
      diagnostics.push({
        code: "lineage_cycle",
        sessionId: rootSessionId,
        parentSessionId: relation.parentSessionId,
        forkMessageId: relation.forkMessageId,
      });
      validRelations.delete(rootSessionId);
      break;
    }
    rootSessionId = relation.parentSessionId;
    ancestors.add(rootSessionId);
  }

  const orderedSessions = orderFamilySessions(
    rootSessionId,
    sessionsById,
    validRelations,
  );
  if (!orderedSessions.some((session) => session.id === currentSessionId)) {
    return { diagnostics };
  }

  const branches: SessionBranchOption[] = [];
  const branchById = new Map<string, SessionBranchOption>();
  for (const session of orderedSessions) {
    const relation = validRelations.get(session.id);
    const copiedPrefixIds = new Set(
      relation
        ? session.messages
            .slice(0, relation.prefixMessageCount)
            .map((entry) => entry.message.id)
        : [],
    );
    let previousUserId: string | null = null;
    let userDepth = 0;
    for (const entry of session.messages) {
      if (entry.message.role !== "user") continue;
      const id = entry.message.id;
      userDepth += 1;

      // OpenCode forks clone every message before the edited boundary with
      // fresh IDs. Those rows are aliases of an ancestor's logical prompts,
      // not new branch options. Keeping their depth contribution preserves
      // the depth of the first genuinely new prompt in this session; loaded
      // copied prompts resolve back to the canonical option by timestamp/text
      // during normalization.
      if (copiedPrefixIds.has(id)) continue;

      if (branchById.has(id)) {
        diagnostics.push({
          code: "duplicate_message_id",
          sessionId: session.id,
          forkMessageId: id,
        });
        continue;
      }
      const prompt = messageText(entry);
      const branch: SessionBranchOption = {
        id,
        sessionId: session.id,
        parentId: previousUserId ?? `opencode-session-root:${session.id}`,
        prompt,
        title: branchTitle(prompt),
        depth: userDepth,
        index: 0,
        siblingIndex: 1,
        siblingCount: 1,
        isActive: session.id === currentSessionId,
        createdAt: messageCreatedAt(entry),
        provider: "opencode",
      };
      branches.push(branch);
      branchById.set(id, branch);
      previousUserId = id;
    }
  }

  let exposedForkCount = 0;
  // Parent-before-child order is important for nested forks: a grandchild
  // edited prompt must inherit the already-normalized logical parent of the
  // prompt it replaces in its direct parent session.
  for (const session of orderedSessions) {
    const relation = validRelations.get(session.id);
    if (!relation) continue;
    const parentBoundary = branchById.get(relation.forkMessageId);
    const child = sessionsById.get(relation.childSessionId);
    if (!parentBoundary || !child) continue;

    const editedEntry = child.messages
      .slice(relation.prefixMessageCount)
      .find((entry) => entry.message.role === "user");
    if (!editedEntry) continue;
    const editedBranch = branchById.get(editedEntry.message.id);
    if (!editedBranch) continue;

    // The source prompt and replacement prompt share the source prompt's
    // logical parent, even though the child's copied prefix has fresh IDs.
    editedBranch.parentId = parentBoundary.parentId;
    editedBranch.depth = parentBoundary.depth;
    exposedForkCount += 1;
  }

  if (exposedForkCount === 0) return { diagnostics };

  const siblingsByParent = new Map<string, SessionBranchOption[]>();
  for (const branch of branches) {
    const parentKey = branch.parentId ?? "<root>";
    const siblings = siblingsByParent.get(parentKey) ?? [];
    siblings.push(branch);
    siblingsByParent.set(parentKey, siblings);
  }
  for (const siblings of siblingsByParent.values()) {
    for (const [index, branch] of siblings.entries()) {
      branch.siblingIndex = index + 1;
      branch.siblingCount = siblings.length;
    }
  }
  for (const [index, branch] of branches.entries()) {
    branch.index = index + 1;
  }

  const currentUserBranches = branches.filter(
    (branch) => branch.sessionId === currentSessionId,
  );
  const activeBranchId = currentUserBranches.at(-1)?.id ?? null;
  const requestedBranchId =
    selectedBranchId && branchById.has(selectedBranchId)
      ? selectedBranchId
      : activeBranchId;

  return {
    diagnostics,
    branchState: {
      sessionId: currentSessionId,
      activeBranchId,
      selectedBranchId: requestedBranchId,
      provider: "opencode",
      branches,
    },
  };
}
