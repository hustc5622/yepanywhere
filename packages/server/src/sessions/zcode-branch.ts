/**
 * ZCode edit-fork branch view.
 *
 * Mirrors buildOpenCodeBranchView (opencode-branch.ts) with one protocol
 * difference: ZCode's `session/fork` copies messages into the child with
 * FRESH ids and Yep never persisted the fork boundary, so the boundary is
 * derived instead of stored.
 *
 * Fork recap (ZCode CLI 0.16.1): editing user message M forks the source at
 * the message BEFORE M (message targets are inclusive). The child therefore
 * copies a text/time-identical prefix of the parent (up to and including the
 * fork target) with fresh ids, and Yep then sends the edited text as the
 * child's first genuinely new user message M'.
 *
 * Derivation (per child → parent edge):
 *   1. `prefixMessageCount` = the longest leading run of child messages whose
 *      text matches the parent's message at the same index (the copied
 *      prefix; order-preserving copy makes same-index comparison safe, and
 *      text-only matching tolerates timestamp drift).
 *   2. Boundary = the first USER message in the parent at index
 *      >= prefixMessageCount — i.e. the original edited message M. M'
 *      inherits M's logical parentId/depth so M and M' render as siblings,
 *      exactly like OpenCode's forkMessageId boundary. When no such user
 *      message exists the edge cannot be reproduced: a diagnostic is
 *      recorded and the edge is skipped.
 *
 * Copied prefix entries never produce branch options. Their loaded copies
 * still resolve back to the canonical option by timestamp/text during
 * normalization (annotateBranchMessages fallback).
 */

import type {
  SessionBranchOption,
  SessionBranchState,
  ZCodeStoredMessage,
} from "@yep-anywhere/shared";

export interface ZCodeBranchFamilySession {
  id: string;
  /** Fork parent session id (native sqlite parent_id / Yep metadata union). */
  parentId?: string | null;
  /** ISO timestamp used to order siblings (session.time_created). */
  createdAt?: string;
  messages: ZCodeStoredMessage[];
}

export interface ZCodeBranchDiagnostic {
  code:
    | "missing_parent"
    | "missing_boundary_message"
    | "lineage_cycle"
    | "duplicate_message_id";
  sessionId: string;
  parentSessionId?: string;
}

export interface ZCodeBranchView {
  branchState?: SessionBranchState;
  diagnostics: ZCodeBranchDiagnostic[];
}

interface ValidForkRelation {
  childSessionId: string;
  parentSessionId: string;
  /** Leading child messages cloned from the parent (never branch options). */
  prefixMessageCount: number;
  /** Native id of the parent's edited user message this fork replaces. */
  boundaryMessageId: string;
}

function messageText(entry: ZCodeStoredMessage): string {
  return entry.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text ?? ""))
    .join("");
}

function messageCreatedAt(entry: ZCodeStoredMessage): string | undefined {
  return typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
    ? new Date(entry.createdAt).toISOString()
    : undefined;
}

function branchTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine || prompt.trim();
  return title.length <= 28 ? title : `${title.slice(0, 27)}...`;
}

/**
 * Longest leading run of child messages cloned from the parent. The ZCode
 * fork copies prefix rows in order with identical text, so a strict
 * same-index comparison is both sufficient and immune to repeated-text
 * ambiguities later in the conversation.
 */
function copiedPrefixLength(
  child: ZCodeStoredMessage[],
  parent: ZCodeStoredMessage[],
): number {
  let length = 0;
  while (
    length < child.length &&
    length < parent.length &&
    child[length]?.role === parent[length]?.role &&
    messageText(child[length] as ZCodeStoredMessage) ===
      messageText(parent[length] as ZCodeStoredMessage)
  ) {
    length += 1;
  }
  return length;
}

function orderFamilySessions(
  rootSessionId: string,
  sessionsById: Map<string, ZCodeBranchFamilySession>,
  relations: Map<string, ValidForkRelation>,
): ZCodeBranchFamilySession[] {
  const childrenByParent = new Map<string, ZCodeBranchFamilySession[]>();
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

  const ordered: ZCodeBranchFamilySession[] = [];
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
 * Build a provider-agnostic branch state for a ZCode edit-fork family.
 * `familySessions` must already contain every member of the family (root to
 * leaves); edges come from each session's `parentId` (.zcode sqlite
 * parent_id and/or Yep's forkParentSessionId metadata, unioned upstream).
 */
export function buildZCodeBranchView(
  familySessions: ZCodeBranchFamilySession[],
  currentSessionId: string,
  selectedBranchId?: string,
): ZCodeBranchView {
  const diagnostics: ZCodeBranchDiagnostic[] = [];
  const sessionsById = new Map(
    familySessions.map((session) => [session.id, session]),
  );
  const current = sessionsById.get(currentSessionId);
  if (!current) return { diagnostics };

  const validRelations = new Map<string, ValidForkRelation>();
  for (const session of familySessions) {
    const parentId = session.parentId;
    if (!parentId) continue;
    const parent = sessionsById.get(parentId);
    if (!parent) {
      diagnostics.push({
        code: "missing_parent",
        sessionId: session.id,
        parentSessionId: parentId,
      });
      continue;
    }
    const prefixMessageCount = copiedPrefixLength(
      session.messages,
      parent.messages,
    );
    // The fork replaced the first user message after the copied prefix —
    // the original edited prompt M in the parent.
    const boundary = parent.messages
      .slice(prefixMessageCount)
      .find((entry) => entry.role === "user");
    if (!boundary) {
      diagnostics.push({
        code: "missing_boundary_message",
        sessionId: session.id,
        parentSessionId: parentId,
      });
      continue;
    }
    validRelations.set(session.id, {
      childSessionId: session.id,
      parentSessionId: parentId,
      prefixMessageCount,
      boundaryMessageId: boundary.id,
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
            .map((entry) => entry.id)
        : [],
    );
    let previousUserId: string | null = null;
    let userDepth = 0;
    for (const entry of session.messages) {
      if (entry.role !== "user") continue;
      const id = entry.id;
      userDepth += 1;

      // ZCode forks clone every message before the edited boundary with
      // fresh ids. Those rows are aliases of an ancestor's logical prompts,
      // not new branch options. Keeping their depth contribution preserves
      // the depth of the first genuinely new prompt in this session; loaded
      // copied prompts resolve back to the canonical option by timestamp/text
      // during normalization.
      if (copiedPrefixIds.has(id)) continue;

      if (branchById.has(id)) {
        diagnostics.push({
          code: "duplicate_message_id",
          sessionId: session.id,
        });
        continue;
      }
      const prompt = messageText(entry);
      const branch: SessionBranchOption = {
        id,
        sessionId: session.id,
        parentId: previousUserId ?? `zcode-session-root:${session.id}`,
        prompt,
        title: branchTitle(prompt),
        depth: userDepth,
        index: 0,
        siblingIndex: 1,
        siblingCount: 1,
        isActive: session.id === currentSessionId,
        createdAt: messageCreatedAt(entry),
        provider: "zcode",
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
    const parentBoundary = branchById.get(relation.boundaryMessageId);
    const child = sessionsById.get(relation.childSessionId);
    if (!parentBoundary || !child) continue;

    const editedEntry = child.messages
      .slice(relation.prefixMessageCount)
      .find((entry) => entry.role === "user");
    if (!editedEntry) continue;
    const editedBranch = branchById.get(editedEntry.id);
    if (!editedBranch) continue;

    // The source prompt and replacement prompt share the source prompt's
    // logical parent, even though the child's copied prefix has fresh ids.
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
      provider: "zcode",
      branches,
    },
  };
}
