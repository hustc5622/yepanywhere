import {
  type ClaudeSessionEntry,
  type SessionBranchOption,
  type SessionBranchState,
  getLogicalParentUuid,
  isClaudeInternalUserPromptEntry,
} from "@yep-anywhere/shared";
import {
  type DagNode,
  buildDag,
  collectAllToolResultIds,
  findOrphanedToolUses,
  findSiblingToolBranches,
  findSiblingToolResults,
} from "./dag.js";
import { isSyntheticUserPromptText } from "./user-prompt-classification.js";

export interface VisibleClaudeEntriesResult {
  entries: ClaudeSessionEntry[];
  orphanedToolUses: Set<string>;
}

export interface ClaudeBranchView extends VisibleClaudeEntriesResult {
  branchState: SessionBranchState;
}

interface NormalizeClaudeEntriesOptions {
  includeOrphans?: boolean;
  branchId?: string;
  sessionId?: string;
}

function getClaudeUserPromptText(raw: ClaudeSessionEntry): string | null {
  if (raw.type !== "user" || isClaudeInternalUserPromptEntry(raw)) return null;

  const content = raw.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 && !isSyntheticUserPromptText(content)
      ? content
      : null;
  }

  if (!Array.isArray(content)) return null;
  if (
    content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "tool_result",
    )
  ) {
    return null;
  }

  const text = content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      return "text" in block && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("\n");

  const trimmed = text.trim();
  return trimmed.length > 0 && !isSyntheticUserPromptText(text) ? text : null;
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

function buildClaudeDagMaps(rawMessages: ClaudeSessionEntry[]): {
  nodeMap: Map<string, DagNode>;
  childrenMap: Map<string | null, string[]>;
} {
  const nodeMap = new Map<string, DagNode>();
  const childrenMap = new Map<string | null, string[]>();

  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    if (!raw) continue;

    const uuid = "uuid" in raw ? raw.uuid : undefined;
    if (!uuid) continue;
    if (raw.type === "progress") continue;

    const parentUuid = "parentUuid" in raw ? (raw.parentUuid ?? null) : null;
    const node: DagNode = { uuid, parentUuid, lineIndex, raw };
    nodeMap.set(uuid, node);

    const children = childrenMap.get(parentUuid) ?? [];
    children.push(uuid);
    childrenMap.set(parentUuid, children);
  }

  return { nodeMap, childrenMap };
}

function findFallbackParentByLineIndex(
  beforeLineIndex: number,
  nodeMap: Map<string, DagNode>,
  excludeUuids: Set<string>,
): DagNode | null {
  let best: DagNode | null = null;
  for (const node of nodeMap.values()) {
    if (node.lineIndex >= beforeLineIndex) continue;
    if (excludeUuids.has(node.uuid)) continue;
    if (!best || node.lineIndex > best.lineIndex) {
      best = node;
    }
  }
  return best;
}

function buildPathToNode(
  nodeMap: Map<string, DagNode>,
  tipUuid: string | null,
): DagNode[] {
  const path: DagNode[] = [];
  const visited = new Set<string>();
  let current = tipUuid ? (nodeMap.get(tipUuid) ?? null) : null;

  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    path.unshift(current);

    let nextUuid = current.parentUuid;
    const logicalParent = getLogicalParentUuid(current.raw);
    if (!nextUuid && logicalParent) {
      nextUuid = logicalParent;
    }

    let nextNode = nextUuid ? (nodeMap.get(nextUuid) ?? null) : null;
    if (!nextNode && nextUuid && logicalParent && !nodeMap.has(logicalParent)) {
      nextNode = findFallbackParentByLineIndex(
        current.lineIndex,
        nodeMap,
        visited,
      );
    }

    current = nextNode;
  }

  return path;
}

function getTipTimestamp(node: DagNode): string {
  return "timestamp" in node.raw && typeof node.raw.timestamp === "string"
    ? node.raw.timestamp
    : "";
}

function findLatestTipUnderNode(
  nodeMap: Map<string, DagNode>,
  childrenMap: Map<string | null, string[]>,
  nodeUuid: string,
): string | null {
  const root = nodeMap.get(nodeUuid);
  if (!root) return null;

  let best = root;
  const stack = [nodeUuid];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const uuid = stack.pop();
    if (!uuid || visited.has(uuid)) continue;
    visited.add(uuid);

    const node = nodeMap.get(uuid);
    if (!node) continue;
    const children = childrenMap.get(uuid) ?? [];
    if (children.length === 0) {
      const bestTs = getTipTimestamp(best);
      const nodeTs = getTipTimestamp(node);
      if (
        nodeTs > bestTs ||
        (nodeTs === bestTs && node.lineIndex > best.lineIndex)
      ) {
        best = node;
      }
      continue;
    }

    stack.push(...children);
  }

  return best.uuid;
}

function findNearestPromptAncestor(
  node: DagNode,
  nodeMap: Map<string, DagNode>,
  promptIds: Set<string>,
): string | null {
  let parentUuid = node.parentUuid;
  const visited = new Set<string>();

  while (parentUuid && !visited.has(parentUuid)) {
    visited.add(parentUuid);
    if (promptIds.has(parentUuid)) return parentUuid;
    const parent = nodeMap.get(parentUuid);
    if (!parent) return null;
    parentUuid = parent.parentUuid;
  }

  return null;
}

function buildClaudeBranchState(args: {
  sessionId: string;
  selectedBranchId?: string;
  activeBranch: DagNode[];
  nodeMap: Map<string, DagNode>;
}): SessionBranchState {
  const { sessionId, selectedBranchId, activeBranch, nodeMap } = args;
  const promptNodes = [...nodeMap.values()].filter(
    (node) => getClaudeUserPromptText(node.raw) !== null,
  );
  const promptIds = new Set(promptNodes.map((node) => node.uuid));
  const parentById = new Map<string, string | null>();

  for (const node of promptNodes) {
    parentById.set(
      node.uuid,
      findNearestPromptAncestor(node, nodeMap, promptIds),
    );
  }

  const depthCache = new Map<string, number>();
  const depthFor = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const parentId = parentById.get(id) ?? null;
    const depth = parentId ? depthFor(parentId) + 1 : 1;
    depthCache.set(id, depth);
    return depth;
  };

  const siblingsByParent = new Map<string, DagNode[]>();
  for (const node of promptNodes) {
    const parentKey = parentById.get(node.uuid) ?? "<root>";
    const siblings = siblingsByParent.get(parentKey) ?? [];
    siblings.push(node);
    siblingsByParent.set(parentKey, siblings);
  }
  for (const siblings of siblingsByParent.values()) {
    siblings.sort((a, b) => a.lineIndex - b.lineIndex);
  }

  const activePromptIds = activeBranch
    .filter((node) => promptIds.has(node.uuid))
    .map((node) => node.uuid);
  const activePathIds = new Set(activePromptIds);
  const activeBranchId =
    activePromptIds.length > 0
      ? (activePromptIds[activePromptIds.length - 1] ?? null)
      : null;
  const requestedBranchId =
    selectedBranchId && promptIds.has(selectedBranchId)
      ? selectedBranchId
      : activeBranchId;

  const branches: SessionBranchOption[] = promptNodes.map((node, index) => {
    const prompt = getClaudeUserPromptText(node.raw) ?? "";
    const parentId = parentById.get(node.uuid) ?? null;
    const siblings = siblingsByParent.get(parentId ?? "<root>") ?? [node];
    const siblingIndex = Math.max(0, siblings.indexOf(node));

    return {
      id: node.uuid,
      sessionId,
      parentId,
      prompt,
      title: branchTitle(prompt),
      depth: depthFor(node.uuid),
      index: index + 1,
      siblingIndex: siblingIndex + 1,
      siblingCount: siblings.length,
      isActive: activePathIds.has(node.uuid),
      createdAt:
        "timestamp" in node.raw && typeof node.raw.timestamp === "string"
          ? node.raw.timestamp
          : undefined,
      provider: "claude",
    };
  });

  return {
    sessionId,
    provider: "claude",
    activeBranchId,
    selectedBranchId: requestedBranchId,
    branches,
  };
}

function hasQueueOperationContent(raw: ClaudeSessionEntry): boolean {
  if (raw.type !== "queue-operation" || raw.operation !== "enqueue") {
    return false;
  }

  if (typeof raw.content === "string") {
    return raw.content.trim().length > 0;
  }

  return Array.isArray(raw.content) && raw.content.length > 0;
}

function collectHistoricalQueueEntries(
  rawMessages: ClaudeSessionEntry[],
): Array<{ lineIndex: number; raw: ClaudeSessionEntry }> {
  const pendingEnqueues: Array<{ lineIndex: number; raw: ClaudeSessionEntry }> =
    [];
  const historicalEntries: Array<{
    lineIndex: number;
    raw: ClaudeSessionEntry;
  }> = [];

  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    if (raw?.type !== "queue-operation") continue;

    if (raw.operation === "enqueue") {
      if (hasQueueOperationContent(raw)) {
        pendingEnqueues.push({ lineIndex, raw });
      }
      continue;
    }

    if (
      (raw.operation === "dequeue" || raw.operation === "remove") &&
      pendingEnqueues.length > 0
    ) {
      const nextEntry = pendingEnqueues.shift();
      if (raw.operation === "remove" && nextEntry) {
        historicalEntries.push(nextEntry);
      }
    }
  }

  return historicalEntries;
}

function insertEntryByLineIndex(
  entries: Array<{ lineIndex: number; raw: ClaudeSessionEntry }>,
  entry: { lineIndex: number; raw: ClaudeSessionEntry },
): void {
  const insertAt = entries.findIndex(
    (existing) => existing.lineIndex > entry.lineIndex,
  );
  if (insertAt === -1) {
    entries.push(entry);
    return;
  }
  entries.splice(insertAt, 0, entry);
}

function collectVisibleEntriesForBranch(
  rawMessages: ClaudeSessionEntry[],
  activeBranch: DagNode[],
  includeOrphans: boolean,
): VisibleClaudeEntriesResult {
  const allToolResultIds = collectAllToolResultIds(rawMessages);
  const orphanedToolUses = includeOrphans
    ? findOrphanedToolUses(activeBranch, allToolResultIds)
    : new Set<string>();

  const lineIndexByUuid = new Map<string, number>();
  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    const uuid = raw && "uuid" in raw ? raw.uuid : undefined;
    if (uuid) {
      lineIndexByUuid.set(uuid, lineIndex);
    }
  }

  const extrasByParent = new Map<
    string,
    Array<{ lineIndex: number; raw: ClaudeSessionEntry }>
  >();

  const pushExtra = (
    parentUuid: string,
    raw: ClaudeSessionEntry,
    lineIndex: number,
  ) => {
    const existing = extrasByParent.get(parentUuid);
    const entry = { lineIndex, raw };
    if (existing) {
      existing.push(entry);
    } else {
      extrasByParent.set(parentUuid, [entry]);
    }
  };

  for (const sibling of findSiblingToolResults(activeBranch, rawMessages)) {
    const uuid = "uuid" in sibling.raw ? sibling.raw.uuid : undefined;
    pushExtra(
      sibling.parentUuid,
      sibling.raw,
      uuid ? (lineIndexByUuid.get(uuid) ?? Number.MAX_SAFE_INTEGER) : 0,
    );
  }

  for (const branch of findSiblingToolBranches(activeBranch, rawMessages)) {
    for (const node of branch.nodes) {
      pushExtra(branch.branchPoint, node.raw, node.lineIndex);
    }
  }

  for (const extras of extrasByParent.values()) {
    extras.sort((left, right) => left.lineIndex - right.lineIndex);
  }

  const entries: Array<{ lineIndex: number; raw: ClaudeSessionEntry }> = [];
  const includedUuids = new Set<string>();
  const includedNonUuidLineIndices = new Set<number>();
  const pushUnique = (raw: ClaudeSessionEntry, lineIndex: number) => {
    if (isClaudeInternalUserPromptEntry(raw)) return;
    const uuid = "uuid" in raw ? raw.uuid : undefined;
    if (uuid) {
      if (includedUuids.has(uuid)) return;
      includedUuids.add(uuid);
    } else {
      if (includedNonUuidLineIndices.has(lineIndex)) return;
      includedNonUuidLineIndices.add(lineIndex);
    }
    entries.push({ lineIndex, raw });
  };

  for (const node of activeBranch) {
    pushUnique(node.raw, node.lineIndex);

    const extras = extrasByParent.get(node.uuid);
    if (!extras) continue;

    for (const extra of extras) {
      pushUnique(extra.raw, extra.lineIndex);
    }
  }

  for (const queuedEntry of collectHistoricalQueueEntries(rawMessages)) {
    const beforeLength = entries.length;
    pushUnique(queuedEntry.raw, queuedEntry.lineIndex);
    if (entries.length === beforeLength) continue;

    const appended = entries.pop();
    if (!appended) continue;
    insertEntryByLineIndex(entries, appended);
  }

  return {
    entries: entries.map((entry) => entry.raw),
    orphanedToolUses,
  };
}

export function buildClaudeBranchView(
  rawMessages: ClaudeSessionEntry[],
  sessionId: string,
  selectedBranchId?: string,
  options: NormalizeClaudeEntriesOptions = {},
): ClaudeBranchView {
  const { includeOrphans = true } = options;
  const dag = buildDag(rawMessages);
  const { nodeMap, childrenMap } = buildClaudeDagMaps(rawMessages);
  const branchState = buildClaudeBranchState({
    sessionId,
    selectedBranchId,
    activeBranch: dag.activeBranch,
    nodeMap,
  });

  const requestedBranchId =
    selectedBranchId &&
    branchState.branches.some((branch) => branch.id === selectedBranchId)
      ? selectedBranchId
      : null;
  const selectedTipId = requestedBranchId
    ? findLatestTipUnderNode(nodeMap, childrenMap, requestedBranchId)
    : dag.tip?.uuid;
  const selectedBranch = requestedBranchId
    ? buildPathToNode(nodeMap, selectedTipId ?? null)
    : dag.activeBranch;

  const visible = collectVisibleEntriesForBranch(
    rawMessages,
    selectedBranch,
    includeOrphans,
  );

  return {
    ...visible,
    branchState,
  };
}

export function collectVisibleClaudeEntries(
  rawMessages: ClaudeSessionEntry[],
  options: NormalizeClaudeEntriesOptions = {},
): VisibleClaudeEntriesResult {
  const branchView = buildClaudeBranchView(
    rawMessages,
    options.sessionId ?? "claude-session",
    options.branchId,
    options,
  );
  return {
    entries: branchView.entries,
    orphanedToolUses: branchView.orphanedToolUses,
  };
}
