import type {
  CodexBranchOption,
  CodexBranchState,
  CodexSessionEntry,
} from "@yep-anywhere/shared";
import { isCodexTurnAbortedNoticeText } from "./codex-turn-aborted.js";
import {
  isSessionSetupText,
  isSyntheticUserPromptText,
} from "./user-prompt-classification.js";

interface CodexBranchNode {
  id: string;
  parentId: string | null;
  prompt: string;
  title: string;
  timestamp?: string;
  depth: number;
  userEntryIndex: number;
  setupEntries: CodexSessionEntry[];
  entries: CodexSessionEntry[];
  children: string[];
}

export interface CodexBranchView {
  entries: CodexSessionEntry[];
  branchState: CodexBranchState;
}

function hasResponseItemUserMessages(entries: CodexSessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "response_item" &&
      entry.payload.type === "message" &&
      entry.payload.role === "user",
  );
}

function isUserTurnStart(
  entry: CodexSessionEntry,
  hasResponseItemUser: boolean,
): boolean {
  if (entry.type === "response_item") {
    return (
      entry.payload.type === "message" &&
      entry.payload.role === "user" &&
      hasResponseItemUser
    );
  }

  return (
    entry.type === "event_msg" &&
    entry.payload.type === "user_message" &&
    !hasResponseItemUser
  );
}

function getResponseMessageText(entry: CodexSessionEntry): string | null {
  if (
    entry.type !== "response_item" ||
    entry.payload.type !== "message" ||
    entry.payload.role !== "user"
  ) {
    return null;
  }

  const text = entry.payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");
  const trimmed = text.trim();
  return trimmed.length > 0 ? text : null;
}

function getEventUserMessageText(entry: CodexSessionEntry): string | null {
  if (entry.type !== "event_msg" || entry.payload.type !== "user_message") {
    return null;
  }

  const text = entry.payload.message.trim();
  return text.length > 0 ? entry.payload.message : null;
}

function getUserTurnText(
  entry: CodexSessionEntry,
  hasResponseItemUser: boolean,
): string | null {
  if (!isUserTurnStart(entry, hasResponseItemUser)) {
    return null;
  }
  return hasResponseItemUser
    ? getResponseMessageText(entry)
    : getEventUserMessageText(entry);
}

function getRollbackNumTurns(entry: CodexSessionEntry): number | null {
  if (entry.type !== "event_msg") return null;

  const payload = entry.payload as { type?: unknown; num_turns?: unknown };
  if (payload.type !== "thread_rolled_back") return null;
  if (typeof payload.num_turns !== "number") return null;
  if (!Number.isInteger(payload.num_turns) || payload.num_turns <= 0) {
    return null;
  }

  return payload.num_turns;
}

function branchTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const text = firstLine ?? prompt.trim();
  if (text.length <= 28) return text;
  return `${text.slice(0, 27)}...`;
}

function buildPathToNode(
  nodesById: Map<string, CodexBranchNode>,
  tipId: string | null,
): CodexBranchNode[] {
  const path: CodexBranchNode[] = [];
  let cursor = tipId;

  while (cursor) {
    const node = nodesById.get(cursor);
    if (!node) break;
    path.push(node);
    cursor = node.parentId;
  }

  return path.reverse();
}

function findLatestTipUnderNode(
  nodesById: Map<string, CodexBranchNode>,
  nodeId: string | null,
): string | null {
  if (!nodeId) return null;
  const root = nodesById.get(nodeId);
  if (!root) return null;

  let best = root;
  const stack = [...root.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const node = nodesById.get(id);
    if (!node) continue;
    if (
      node.children.length === 0 &&
      node.userEntryIndex > best.userEntryIndex
    ) {
      best = node;
    }
    stack.push(...node.children);
  }

  return best.id;
}

function siblingIdsForNode(
  node: CodexBranchNode,
  nodesById: Map<string, CodexBranchNode>,
  rootNodeIds: string[],
): string[] {
  if (!node.parentId) return rootNodeIds;
  return nodesById.get(node.parentId)?.children ?? [node.id];
}

function buildBranchState(args: {
  sessionId: string;
  nodes: CodexBranchNode[];
  nodesById: Map<string, CodexBranchNode>;
  rootNodeIds: string[];
  activePathIds: Set<string>;
  activeBranchId: string | null;
  selectedBranchId: string | null;
}): CodexBranchState {
  const {
    sessionId,
    nodes,
    nodesById,
    rootNodeIds,
    activePathIds,
    activeBranchId,
    selectedBranchId,
  } = args;

  const branches: CodexBranchOption[] = nodes.map((node, index) => {
    const siblings = siblingIdsForNode(node, nodesById, rootNodeIds);
    const siblingIndex = Math.max(0, siblings.indexOf(node.id));
    return {
      id: node.id,
      sessionId,
      parentId: node.parentId,
      prompt: node.prompt,
      title: node.title,
      depth: node.depth,
      index: index + 1,
      siblingIndex: siblingIndex + 1,
      siblingCount: siblings.length,
      isActive: activePathIds.has(node.id),
      createdAt: node.timestamp,
    };
  });

  return {
    sessionId,
    activeBranchId,
    selectedBranchId,
    branches,
  };
}

/**
 * Build a visible Codex branch from an append-only rollout.
 *
 * Codex keeps old turns in the JSONL file and appends `thread_rolled_back`
 * markers. This reconstructs a lightweight turn tree so the UI can render the
 * latest branch by default or project an older sibling branch for review.
 */
export function buildCodexBranchView(
  entries: CodexSessionEntry[],
  sessionId: string,
  selectedBranchId?: string,
): CodexBranchView {
  const hasResponseItemUser = hasResponseItemUserMessages(entries);
  const prefixEntries: CodexSessionEntry[] = [];
  const nodes: CodexBranchNode[] = [];
  const nodesById = new Map<string, CodexBranchNode>();
  const rootNodeIds: string[] = [];
  let activePathIds: string[] = [];
  let currentNode: CodexBranchNode | null = null;
  let pendingSetupEntries: CodexSessionEntry[] = [];
  let sawConversationTurn = false;

  for (const [entryIndex, entry] of entries.entries()) {
    const numTurns = getRollbackNumTurns(entry);
    if (numTurns !== null) {
      activePathIds = activePathIds.slice(
        0,
        Math.max(0, activePathIds.length - numTurns),
      );
      currentNode =
        activePathIds.length > 0
          ? (nodesById.get(activePathIds[activePathIds.length - 1] ?? "") ??
            null)
          : null;
      pendingSetupEntries = [];
      continue;
    }

    const userText = getUserTurnText(entry, hasResponseItemUser);
    if (userText !== null) {
      if (isCodexTurnAbortedNoticeText(userText)) {
        continue;
      }

      if (isSessionSetupText(userText)) {
        if (sawConversationTurn) {
          pendingSetupEntries.push(entry);
        } else {
          prefixEntries.push(entry);
        }
        continue;
      }
      if (isSyntheticUserPromptText(userText)) {
        continue;
      }

      const parentId =
        activePathIds.length > 0
          ? (activePathIds[activePathIds.length - 1] ?? null)
          : null;
      const id = `codex-branch-${entryIndex}`;
      const parent = parentId ? nodesById.get(parentId) : undefined;
      const node: CodexBranchNode = {
        id,
        parentId,
        prompt: userText,
        title: branchTitle(userText),
        timestamp: entry.timestamp,
        depth: parent ? parent.depth + 1 : 1,
        userEntryIndex: entryIndex,
        setupEntries: pendingSetupEntries,
        entries: [entry],
        children: [],
      };

      pendingSetupEntries = [];
      nodes.push(node);
      nodesById.set(id, node);
      if (parent) {
        parent.children.push(id);
      } else {
        rootNodeIds.push(id);
      }

      activePathIds = [...activePathIds, id];
      currentNode = node;
      sawConversationTurn = true;
      continue;
    }

    if (!sawConversationTurn) {
      prefixEntries.push(entry);
    } else if (currentNode) {
      currentNode.entries.push(entry);
    } else {
      pendingSetupEntries.push(entry);
    }
  }

  const activeBranchId =
    activePathIds.length > 0
      ? (activePathIds[activePathIds.length - 1] ?? null)
      : null;
  const requestedNodeId =
    selectedBranchId && nodesById.has(selectedBranchId)
      ? selectedBranchId
      : activeBranchId;
  const selectedTipId =
    requestedNodeId === activeBranchId
      ? activeBranchId
      : findLatestTipUnderNode(nodesById, requestedNodeId);
  const selectedPath = buildPathToNode(nodesById, selectedTipId);
  const selectedEntries: CodexSessionEntry[] = [...prefixEntries];

  for (const node of selectedPath) {
    selectedEntries.push(...node.setupEntries, ...node.entries);
  }

  const activePathSet = new Set(activePathIds);
  return {
    entries: selectedEntries,
    branchState: buildBranchState({
      sessionId,
      nodes,
      nodesById,
      rootNodeIds,
      activePathIds: activePathSet,
      activeBranchId,
      selectedBranchId: requestedNodeId,
    }),
  };
}

/**
 * Apply Codex CLI `thread_rolled_back` markers to persisted rollout entries.
 *
 * Codex backtrack/rollback keeps old response_item lines on disk and appends a
 * marker instead. This returns the visible branch by dropping the requested
 * number of user turns from the history accumulated before each marker.
 */
export function applyCodexRollbackMarkers(
  entries: CodexSessionEntry[],
): CodexSessionEntry[] {
  return buildCodexBranchView(entries, "codex-session").entries;
}

export interface CodexRollbackTarget {
  /** Entry timestamp of the edited user turn, when known. */
  timestamp?: string;
  /** Prompt text of the edited user turn. */
  prompt: string;
}

function orderedActivePath(branchState: CodexBranchState): CodexBranchOption[] {
  const byId = new Map(
    branchState.branches.map((branch) => [branch.id, branch]),
  );
  const path: CodexBranchOption[] = [];
  let cursor = branchState.activeBranchId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    path.push(node);
    cursor = node.parentId;
  }
  return path.reverse();
}

/**
 * Compute the authoritative `thread/rollback` turn count for editing a user
 * prompt. Codex rollback semantics count user turns on the *active* path, so
 * the count must come from the persisted turn tree - not from however many
 * user prompts the client happened to render (setup folding, dedupe, and
 * viewing an older branch all skew the client-side count).
 *
 * When the edited turn sits on a sibling branch, the rollback unwinds the
 * active path back to the deepest common ancestor.
 */
export function computeCodexRollbackNumTurns(
  branchState: CodexBranchState,
  target: CodexRollbackTarget,
): number | null {
  const activePath = orderedActivePath(branchState);
  if (activePath.length === 0) return null;

  const targetPrompt = target.prompt.trim();
  if (!targetPrompt) return null;

  const promptMatches = branchState.branches.filter(
    (branch) => branch.prompt.trim() === targetPrompt,
  );
  if (promptMatches.length === 0) return null;

  const timestampMatches = target.timestamp
    ? promptMatches.filter((branch) => branch.createdAt === target.timestamp)
    : [];
  const candidates =
    timestampMatches.length > 0 ? timestampMatches : promptMatches;

  // Prefer a candidate on the active path; otherwise take the most recent.
  const activeIds = new Map(activePath.map((node, index) => [node.id, index]));
  const onActive = candidates.filter((branch) => activeIds.has(branch.id));
  const candidate =
    onActive.length > 0
      ? (onActive[onActive.length - 1] as CodexBranchOption)
      : (candidates[candidates.length - 1] as CodexBranchOption);

  const activeIndex = activeIds.get(candidate.id);
  if (activeIndex !== undefined) {
    const numTurns = activePath.length - activeIndex;
    return numTurns > 0 ? numTurns : null;
  }

  // Edited turn is on a sibling branch: roll back to the deepest ancestor
  // shared with the active path (the new prompt becomes a fresh sibling).
  const byId = new Map(
    branchState.branches.map((branch) => [branch.id, branch]),
  );
  let cursor = candidate.parentId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const ancestorIndex = activeIds.get(cursor);
    if (ancestorIndex !== undefined) {
      const numTurns = activePath.length - (ancestorIndex + 1);
      return numTurns > 0 ? numTurns : null;
    }
    cursor = byId.get(cursor)?.parentId ?? null;
  }

  // No shared ancestor: unwind the entire active path.
  return activePath.length;
}
