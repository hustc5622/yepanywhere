export interface CollapsibleForkFamilyMember {
  id: string;
  /** Set when this session is an edit-fork child of another session. */
  forkParentSessionId?: string;
  /** ISO timestamp used to pick the most recent member as the representative. */
  updatedAt: string;
  title?: string | null;
  fullTitle?: string | null;
}

/**
 * Collapse provider edit-fork families to their most recently updated member.
 * Hidden members remain addressable by id for branch navigation.
 */
export function collapseEditForkFamilies<T extends CollapsibleForkFamilyMember>(
  summaries: T[],
): T[] {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
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
  return summaries
    .filter((summary) => keep.has(summary.id))
    .map((summary) => {
      const root = byId.get(find(summary.id));
      if (!root || root.id === summary.id || !root.title) return summary;
      return {
        ...summary,
        title: root.title,
        fullTitle: root.fullTitle ?? root.title,
      };
    });
}

function isMoreRecentMember(
  candidate: CollapsibleForkFamilyMember,
  current: CollapsibleForkFamilyMember,
): boolean {
  const candidateAt = new Date(candidate.updatedAt).getTime();
  const currentAt = new Date(current.updatedAt).getTime();
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  return candidate.id > current.id;
}
