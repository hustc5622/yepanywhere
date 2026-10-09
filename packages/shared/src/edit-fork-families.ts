export interface CollapsibleForkFamilyMember {
  id: string;
  /** Set when this session is an edit-fork child of another session. */
  forkParentSessionId?: string;
  /** ISO timestamp used to pick the most recent member as the representative. */
  updatedAt: string;
  /** All known native sessions represented by this logical conversation. */
  forkFamilySessionIds?: string[];
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
    const related = [
      ...(summary.forkFamilySessionIds ?? []),
      ...(summary.forkParentSessionId ? [summary.forkParentSessionId] : []),
    ];
    for (const id of related) {
      if (id === summary.id) continue;
      if (!parentOf.has(id)) parentOf.set(id, id);
      const childRoot = find(summary.id);
      const parentRoot = find(id);
      if (childRoot !== parentRoot) parentOf.set(childRoot, parentRoot);
      hasEdge = true;
    }
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

  const membersByRoot = new Map<string, string[]>();
  for (const id of parentOf.keys()) {
    const root = find(id);
    const members = membersByRoot.get(root) ?? [];
    members.push(id);
    membersByRoot.set(root, members);
  }
  // The union root can be an unloaded ancestor. Keep an inherited family
  // title when a new child arrives before that ancestor's list row does.
  const titleByRoot = new Map<string, T>();
  for (const member of summaries) {
    if (!member.title) continue;
    const root = find(member.id);
    const existing = titleByRoot.get(root);
    if (
      !existing ||
      !member.forkParentSessionId ||
      (member.forkFamilySessionIds?.length &&
        existing.forkParentSessionId &&
        !existing.forkFamilySessionIds?.length)
    ) {
      titleByRoot.set(root, member);
    }
  }
  const keep = new Set(
    [...representativeByRoot.values()].map((summary) => summary.id),
  );
  return summaries
    .filter((summary) => keep.has(summary.id))
    .map((summary) => {
      const root = titleByRoot.get(find(summary.id));
      const members = membersByRoot.get(find(summary.id)) ?? [];
      if (members.length <= 1) return summary;
      return {
        ...summary,
        forkFamilySessionIds: members,
        ...(root?.title && root.id !== summary.id
          ? { title: root.title, fullTitle: root.fullTitle ?? root.title }
          : {}),
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
